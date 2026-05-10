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

/**
 * How the session is run and rendered.
 *  - `terminal`: existing PTY/xterm flow.  All non-Claude sessions use this.
 *  - `agent`:    `claude --print` stream-json subprocess driving an
 *                `<AgentSessionView>` chat surface.  Claude-only in 1.0.0.
 */
export type SessionMode = "terminal" | "agent";

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
  /** Command prepended to the AI-agent launch string (e.g. "caffeinate -i",
   *  "wsl", "nice -n 10"). Trimmed. Ignored for SSH sessions. */
  custom_prefix: string;
  custom_suffix: string;
  channels: string[];
  context_injected: boolean;
  ssh_info: SshConnectionInfo | null;
  /** "terminal" → existing PTY/xterm flow.  "agent" → `claude --print`
   *  stream-json subprocess + AgentSessionView render.  Claude-only in 1.0.0. */
  mode: SessionMode;
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
  customPrefix?: string;
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
  /** Frontend-chosen session mode.  Defaults to `agent` for Claude, `terminal` otherwise. */
  mode?: SessionMode;
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
  custom_prefix: string;
  custom_suffix: string;
  project_ids: string[];
  ssh_info?: SshConnectionInfo | null;
  /** Optional for backward compat with 0.6.16 saved workspaces.
   *  When missing, the migration defaults to "terminal" so existing
   *  sessions never silently auto-convert to agent mode on restore. */
  mode?: SessionMode;
  // ─── Agent-mode persistence (v2) ─────────────────────────────────
  /** Canonical Claude session UUID captured from the SDK's init event.
   *  Used to `--resume <uuid>` on workspace restore so a multi-turn
   *  conversation survives across app restarts.  Optional because old
   *  saved workspaces predate this field. */
  claude_session_uuid?: string;
  /** Last-active model (e.g., "haiku") so a respawn picks the same one. */
  agent_model?: string;
  /** Last-active --permission-mode value. */
  agent_permission_mode?: string;
  /** Last-active --effort value. */
  agent_effort?: string;
  /** Currently-attached additional directories (Hermes' projects). */
  agent_add_dirs?: string[];
}

export interface SavedWorkspace {
  /** Schema version — bump when fields change to enable forward-compatible parsing. */
  version?: number;
  sessions: SavedSessionInfo[];
  layout: unknown; // serialized LayoutNode
  focused_pane_id: string | null;
  active_session_id: string | null;
  /** Right-rail Workbench layout (open / tab / ratio / files-notes split).
   *  Added in v1.1.14.  Older saves omit this; the loader falls back to
   *  defaults from `utils/workbenchLayout.ts`. */
  workbench?: unknown;
  /** Per-session free-form notes (1.1.14).  Map of sessionId -> string,
   *  capped at NOTES_MAX_LEN per entry by the loader. */
  notes?: Record<string, string>;
}

/** Current schema version for SavedWorkspace serialisation.
 *  v2 adds agent-mode persistence fields (claude_session_uuid + the
 *  active model / permission_mode / effort / add_dirs) so an agent
 *  session can be resumed mid-conversation across app restarts. */
export const SAVED_WORKSPACE_VERSION = 2;

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
    if (typeof si.custom_prefix !== "string") si.custom_prefix = "";
    if (typeof si.custom_suffix !== "string") si.custom_suffix = "";
    if (!Array.isArray(si.project_ids)) si.project_ids = [];
    // Default missing `mode` to "terminal" so existing 0.6.16 workspaces
    // never silently auto-convert sessions to agent mode on restore.
    if (si.mode !== "agent" && si.mode !== "terminal") {
      si.mode = "terminal";
    }
    // Agent-state fields (v2): pass through if present, normalize to
    // undefined otherwise so `saved.agent_model` reads as undefined for
    // older saves and the restore code uses Claude's default model.
    if (si.claude_session_uuid !== undefined && typeof si.claude_session_uuid !== "string") {
      delete si.claude_session_uuid;
    }
    for (const f of ["agent_model", "agent_permission_mode", "agent_effort"] as const) {
      if (si[f] !== undefined && typeof si[f] !== "string") {
        delete si[f];
      }
    }
    if (si.agent_add_dirs !== undefined && !Array.isArray(si.agent_add_dirs)) {
      delete si.agent_add_dirs;
    }
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
  | { type: "TOGGLE_USAGE" }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "TOGGLE_PALETTE" }
  | { type: "CLOSE_PALETTE" }
  | { type: "SET_EXECUTION_MODE"; sessionId: string; mode: ExecutionMode }
  | { type: "SET_DEFAULT_MODE"; mode: ExecutionMode }
  /** Convert an existing session to a different runtime mode (terminal ↔ agent).
   *  The caller is responsible for tearing down the previous-mode subprocess
   *  and spawning the new one before/after dispatching this action. */
  | { type: "SET_SESSION_MODE"; sessionId: string; mode: SessionMode }
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
  | { type: "SET_COMPOSER_DRAFT"; sessionId: string; draft: string }
  | { type: "SET_COMPOSER_HEIGHT"; sessionId: string; height: number }
  | { type: "TOGGLE_COMPOSER_EXPANDED"; sessionId: string }
  | { type: "SET_COMPOSER_EXPANDED"; sessionId: string; expanded: boolean }
  // File preview
  | { type: "SET_FILE_PREVIEW"; projectId: string; filePath: string }
  | { type: "CLOSE_FILE_PREVIEW" }
  // Right-rail Workbench (v1.1.14) — agent-mode only.  See
  // `utils/workbenchLayout.ts` for the persisted shape.
  | { type: "TOGGLE_WORKBENCH" }
  | { type: "SET_WORKBENCH_OPEN"; open: boolean }
  | { type: "SET_WORKBENCH_TAB"; tab: "files" | "context" | "git" }
  | { type: "SET_WORKBENCH_RATIO"; ratio: number }
  | { type: "SET_WORKBENCH_FILES_NOTES_SPLIT"; ratio: number }
  // Per-session notes (1.1.14) — replaces or complements the
  // session-row description as a longer-form scratchpad.
  | { type: "SET_SESSION_NOTE"; sessionId: string; content: string }
  // Workspace restore
  | { type: "RESTORE_LAYOUT"; root: unknown; focusedPaneId: string | null; activeSessionId: string | null }
  // Workbench restore — applied alongside RESTORE_LAYOUT after a saved
  // workspace is parsed.  Both notes and panel layout come from the
  // same JSON blob, but the reducer treats them as separate slices so
  // a partial restore can apply notes without resetting the panel.
  | { type: "RESTORE_WORKBENCH"; layout: import("../utils/workbenchLayout").PersistedWorkbenchLayout; notes: Record<string, string> };
