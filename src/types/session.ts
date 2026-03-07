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

export interface SessionData {
  id: string;
  label: string;
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
  context_injected: boolean;
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

// ─── Execution Nodes (mirror Rust struct) ────────────────────────────

export interface ExecutionNode {
  id: number;
  session_id: string;
  timestamp: number;
  kind: string;
  input: string | null;
  output_summary: string | null;
  exit_code: number | null;
  working_dir: string;
  duration_ms: number;
  metadata: string | null;
}

// ─── Execution Mode ──────────────────────────────────────────────────

export type ExecutionMode = "manual" | "assisted" | "autonomous";

// ─── Session Creation ────────────────────────────────────────────────

export interface CreateSessionOpts {
  sessionId?: string;
  label?: string;
  workingDirectory?: string;
  restoreFromId?: string;
  aiProvider?: string;
  projectIds?: string[];
  branchName?: string;
  createNewBranch?: boolean;
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
  | { type: "TOGGLE_TIMELINE" }
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
  | { type: "CLOSE_COMPOSER" };
