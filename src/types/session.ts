// ─── Session Types (mirror Rust structs) ─────────────────────────────

export interface AgentInfo {
  name: string;
  provider: string;
  model: string | null;
  detected_at: string;
  confidence: number;
}

export interface ToolCall {
  tool: string;
  args: string;
  timestamp: string;
}

export interface ProviderTokens {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  model: string;
  last_updated: string;
  update_count: number;
}

export interface ActionEvent {
  command: string;
  label: string;
  provider: string;
  is_suggestion: boolean;
  timestamp: string;
}

export interface ActionTemplate {
  command: string;
  label: string;
  description: string;
  category: string;
}

export interface MemoryFact {
  key: string;
  value: string;
  source: string;
  confidence: number;
}

export interface SessionMetrics {
  output_lines: number;
  error_count: number;
  stuck_score: number;
  token_usage: Record<string, ProviderTokens>;
  tool_calls: ToolCall[];
  tool_call_summary: Record<string, number>;
  files_touched: string[];
  recent_errors: string[];
  recent_actions: ActionEvent[];
  available_actions: ActionTemplate[];
  memory_facts: MemoryFact[];
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  latency_samples: number[];
  token_history: [number, number][];
}

export interface PortForward {
  local_port: number;
  remote_host: string;
  remote_port: number;
  label?: string | null;
}

export interface SshConnectionInfo {
  host: string;
  port: number;
  user: string;
  tmux_session?: string | null;
  identity_file?: string | null;
  port_forwards: PortForward[];
}

export interface TmuxSessionEntry {
  name: string;
  windows: number;
  attached: boolean;
}

export interface TmuxWindowEntry {
  index: number;
  name: string;
  active: boolean;
}

export interface SessionData {
  id: string;
  label: string;
  description: string;
  color: string;
  group: string | null;
  phase: string;
  working_directory: string;
  shell: string;
  created_at: string;
  last_activity_at: string;
  workspace_paths: string[];
  detected_agent: AgentInfo | null;
  metrics: SessionMetrics;
  ai_provider: string | null;
  auto_approve: boolean;
  permission_mode: string;
  custom_suffix: string;
  channels: string[];
  context_injected: boolean;
  ssh_info: SshConnectionInfo | null;
}

export interface SessionHistoryEntry {
  id: string;
  label: string;
  color: string;
  working_directory: string;
  shell: string;
  created_at: string;
  closed_at: string | null;
  scrollback_preview: string | null;
}

// ─── Execution Mode ──────────────────────────────────────────────────

export type ExecutionMode = "manual" | "assisted" | "autonomous";

// ─── Permission Mode ────────────────────────────────────────────────

export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "dontAsk" | "bypassPermissions";

// ─── Session Creation ────────────────────────────────────────────────

export interface CreateSessionOpts {
  sessionId?: string;
  label?: string;
  description?: string;
  group?: string;
  color?: string;
  workingDirectory?: string;
  restoreFromId?: string;
  aiProvider?: string;
  autoApprove?: boolean;
  permissionMode?: string;
  customSuffix?: string;
  projectIds?: string[];
  branchName?: string;
  createNewBranch?: boolean;
  /** Per-project branch selections: projectId -> { branch, createNew, fromRemote? } */
  branchSelections?: Record<string, { branch: string; createNew: boolean; fromRemote?: string }>;
  channels?: string[];
  sshHost?: string;
  sshPort?: number;
  sshUser?: string;
  tmuxSession?: string;
  sshIdentityFile?: string;
}

// ─── Workspace Restore ──────────────────────────────────────────────

export interface SavedSessionInfo {
  id: string;
  label: string;
  description: string;
  color: string;
  group: string | null;
  working_directory: string;
  ai_provider: string | null;
  auto_approve: boolean;
  permission_mode: string;
  custom_suffix: string;
  project_ids: string[];
  ssh_info?: SshConnectionInfo | null;
}

export interface SavedWorkspace {
  /** Schema version — bump when fields change to enable forward-compatible parsing. */
  version?: number;
  sessions: SavedSessionInfo[];
  layout: unknown; // serialized LayoutNode
  focused_pane_id: string | null;
  active_session_id: string | null;
}

/** Current schema version for SavedWorkspace serialisation. */
export const SAVED_WORKSPACE_VERSION = 1;

/**
 * Validate a parsed JSON blob against the SavedWorkspace shape.
 * Returns `null` if invalid, otherwise returns the validated workspace.
 */
export function validateSavedWorkspace(raw: unknown): SavedWorkspace | null {
  if (raw === null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;

  // `sessions` must be a non-empty array of objects with at least `id` and `label`
  if (!Array.isArray(obj.sessions) || obj.sessions.length === 0) return null;
  for (const s of obj.sessions) {
    if (s === null || typeof s !== "object") return null;
    const si = s as Record<string, unknown>;
    if (typeof si.id !== "string" || !si.id) return null;
    if (typeof si.label !== "string") return null;
    // Provide defaults for optional fields that may be missing in older versions
    if (typeof si.description !== "string") si.description = "";
    if (typeof si.color !== "string") si.color = "";
    if (typeof si.working_directory !== "string") si.working_directory = "";
    if (typeof si.auto_approve !== "boolean") si.auto_approve = false;
    if (typeof si.permission_mode !== "string") {
      si.permission_mode = si.auto_approve ? "bypassPermissions" : "default";
    }
    if (typeof si.custom_suffix !== "string") si.custom_suffix = "";
    if (!Array.isArray(si.project_ids)) si.project_ids = [];
  }

  return {
    version: typeof obj.version === "number" ? obj.version : 0,
    sessions: obj.sessions as SavedSessionInfo[],
    layout: obj.layout ?? null,
    focused_pane_id: typeof obj.focused_pane_id === "string" ? obj.focused_pane_id : null,
    active_session_id: typeof obj.active_session_id === "string" ? obj.active_session_id : null,
  };
}

// ─── Session Action (reducer) ────────────────────────────────────────

import type { SplitDirection } from "../state/layoutTypes";

export type SessionAction =
  | { type: "SESSION_UPDATED"; session: SessionData }
  | { type: "SESSION_REMOVED"; id: string }
  | { type: "SET_ACTIVE"; id: string | null }
  | { type: "SET_RECENT"; entries: SessionHistoryEntry[] }
  | { type: "TOGGLE_CONTEXT" }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "TOGGLE_PALETTE" }
  | { type: "CLOSE_PALETTE" }
  | { type: "SET_EXECUTION_MODE"; sessionId: string; mode: ExecutionMode }
  | { type: "SET_DEFAULT_MODE"; mode: ExecutionMode }
  | { type: "TOGGLE_FLOW_MODE" }
  | { type: "SHOW_AUTO_TOAST"; command: string; reason: string; sessionId: string }
  | { type: "DISMISS_AUTO_TOAST" }
  | { type: "TOGGLE_AUTO_APPLY" }
  | { type: "SET_AUTONOMOUS_SETTINGS"; settings: Partial<{ commandMinFrequency: number; cancelDelayMs: number }> }
  // Injection lock actions
  | { type: "ACQUIRE_INJECTION_LOCK"; sessionId: string }
  | { type: "RELEASE_INJECTION_LOCK"; sessionId: string }
  // Layout actions
  | { type: "INIT_PANE"; sessionId: string }
  | { type: "SPLIT_PANE"; paneId: string; direction: SplitDirection; newSessionId: string; insertBefore?: boolean }
  | { type: "CLOSE_PANE"; paneId: string }
  | { type: "FOCUS_PANE"; paneId: string }
  | { type: "RESIZE_SPLIT"; splitId: string; ratio: number }
  | { type: "SET_PANE_SESSION"; paneId: string; sessionId: string }
  // Close confirmation actions
  | { type: "REQUEST_CLOSE_SESSION"; id: string }
  | { type: "CANCEL_CLOSE_SESSION" }
  | { type: "SET_SKIP_CLOSE_CONFIRM"; skip: boolean }
  // Process panel actions
  | { type: "TOGGLE_PROCESS_PANEL" }
  | { type: "SET_LEFT_TAB"; tab: "sessions" | "terminal" | "processes" | "git" | "files" | "search" }
  // Git panel actions
  | { type: "TOGGLE_GIT_PANEL" }
  // File explorer actions
  | { type: "TOGGLE_FILE_EXPLORER" }
  // Search panel actions
  | { type: "TOGGLE_SEARCH_PANEL" }
  // Sub-view panel (opens panel without collapsing session list)
  | { type: "SET_SUBVIEW_PANEL"; panel: "git" | "files" | "search" | null }
  // Composer actions
  | { type: "OPEN_COMPOSER" }
  | { type: "CLOSE_COMPOSER" }
  // File preview
  | { type: "SET_FILE_PREVIEW"; projectId: string; filePath: string }
  | { type: "CLOSE_FILE_PREVIEW" }
  // Workspace restore
  | { type: "RESTORE_LAYOUT"; root: unknown; focusedPaneId: string | null; activeSessionId: string | null };
