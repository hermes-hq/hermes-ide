import { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createTerminal, destroy as destroyTerminal, updateSettings, writeScrollback } from "../terminal/TerminalPool";
import { initNotifications, notifyStuck, notifyLongRunningDone } from "../utils/notifications";
import {
  LayoutNode, PaneLeaf, SplitDirection,
  nextPaneId, nextSplitId,
  replaceNode, removePane, collectPanes, updateSplitRatio,
  setPaneSession, removePanesBySession,
} from "./layoutTypes";

// ─── Types (mirror Rust structs) ────────────────────────────────────

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

// ─── State ──────────────────────────────────────────────────────────

interface SessionState {
  sessions: Record<string, SessionData>;
  activeSessionId: string | null;
  recentSessions: SessionHistoryEntry[];
  defaultMode: ExecutionMode;
  executionModes: Record<string, ExecutionMode>;
  autonomousSettings: {
    errorMinOccurrences: number;
    commandMinFrequency: number;
    cancelDelayMs: number;
  };
  autoApplyEnabled: boolean;
  layout: {
    root: LayoutNode | null;
    focusedPaneId: string | null;
  };
  ui: {
    contextPanelOpen: boolean;
    sessionListCollapsed: boolean;
    commandPaletteOpen: boolean;
    stuckOverlaySessionId: string | null;
    dismissedStuckSessions: Set<string>;
    flowMode: boolean;
    timelineOpen: boolean;
    autoToast: { command: string; reason: string; sessionId: string } | null;
  };
}

export type SessionAction =
  | { type: "SESSION_UPDATED"; session: SessionData }
  | { type: "SESSION_REMOVED"; id: string }
  | { type: "SET_ACTIVE"; id: string | null }
  | { type: "SET_RECENT"; entries: SessionHistoryEntry[] }
  | { type: "TOGGLE_CONTEXT" }
  | { type: "TOGGLE_SIDEBAR" }
  | { type: "TOGGLE_PALETTE" }
  | { type: "SHOW_STUCK_OVERLAY"; sessionId: string }
  | { type: "DISMISS_STUCK_OVERLAY" }
  | { type: "SET_EXECUTION_MODE"; sessionId: string; mode: ExecutionMode }
  | { type: "SET_DEFAULT_MODE"; mode: ExecutionMode }
  | { type: "TOGGLE_FLOW_MODE" }
  | { type: "TOGGLE_TIMELINE" }
  | { type: "SHOW_AUTO_TOAST"; command: string; reason: string; sessionId: string }
  | { type: "DISMISS_AUTO_TOAST" }
  | { type: "TOGGLE_AUTO_APPLY" }
  | { type: "SET_AUTONOMOUS_SETTINGS"; settings: Partial<SessionState["autonomousSettings"]> }
  // Layout actions
  | { type: "INIT_PANE"; sessionId: string }
  | { type: "SPLIT_PANE"; paneId: string; direction: SplitDirection; newSessionId: string; insertBefore?: boolean }
  | { type: "CLOSE_PANE"; paneId: string }
  | { type: "FOCUS_PANE"; paneId: string }
  | { type: "RESIZE_SPLIT"; splitId: string; ratio: number }
  | { type: "SET_PANE_SESSION"; paneId: string; sessionId: string };

/** @internal — exported for testing */
export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "SESSION_UPDATED": {
      return {
        ...state,
        sessions: { ...state.sessions, [action.session.id]: action.session },
      };
    }
    case "SESSION_REMOVED": {
      const { [action.id]: _, ...rest } = state.sessions;
      const ids = Object.keys(rest);
      // Remove panes displaying this session from layout
      let newRoot = state.layout.root;
      if (newRoot) {
        newRoot = removePanesBySession(newRoot, action.id);
      }
      // Determine new focused pane
      let newFocused = state.layout.focusedPaneId;
      if (newRoot) {
        const panes = collectPanes(newRoot);
        if (newFocused && !panes.some((p) => p.id === newFocused)) {
          newFocused = panes.length > 0 ? panes[0].id : null;
        }
      } else {
        newFocused = null;
      }
      // Determine new active session from focused pane
      const focusedPane = newRoot && newFocused
        ? collectPanes(newRoot).find((p) => p.id === newFocused)
        : null;
      const newActive = focusedPane
        ? focusedPane.sessionId
        : (state.activeSessionId === action.id
          ? (ids.length > 0 ? ids[ids.length - 1] : null)
          : state.activeSessionId);
      // Clean dismissed set
      const newDismissed = new Set(state.ui.dismissedStuckSessions);
      newDismissed.delete(action.id);
      return {
        ...state,
        sessions: rest,
        activeSessionId: newActive,
        layout: { root: newRoot, focusedPaneId: newFocused },
        ui: { ...state.ui, dismissedStuckSessions: newDismissed },
      };
    }
    case "SET_ACTIVE": {
      if (!action.id) {
        return { ...state, activeSessionId: null };
      }
      // If no layout exists, auto-create a pane for this session
      if (!state.layout.root) {
        const autoId = nextPaneId();
        const autoPane: PaneLeaf = { type: "pane", id: autoId, sessionId: action.id };
        return {
          ...state,
          activeSessionId: action.id,
          layout: { root: autoPane, focusedPaneId: autoId },
        };
      }
      // If a pane already shows this session, focus it
      const existing = collectPanes(state.layout.root).find((p) => p.sessionId === action.id);
      if (existing) {
        return {
          ...state,
          activeSessionId: action.id,
          layout: { ...state.layout, focusedPaneId: existing.id },
        };
      }
      // Otherwise, swap the focused pane's session
      if (state.layout.focusedPaneId) {
        const swapped = setPaneSession(state.layout.root, state.layout.focusedPaneId, action.id);
        return {
          ...state,
          activeSessionId: action.id,
          layout: { ...state.layout, root: swapped },
        };
      }
      return { ...state, activeSessionId: action.id };
    }
    case "SET_RECENT":
      return { ...state, recentSessions: action.entries };
    case "TOGGLE_CONTEXT":
      return { ...state, ui: { ...state.ui, contextPanelOpen: !state.ui.contextPanelOpen } };
    case "TOGGLE_SIDEBAR":
      return { ...state, ui: { ...state.ui, sessionListCollapsed: !state.ui.sessionListCollapsed } };
    case "TOGGLE_PALETTE":
      return { ...state, ui: { ...state.ui, commandPaletteOpen: !state.ui.commandPaletteOpen } };
    case "SHOW_STUCK_OVERLAY":
      return { ...state, ui: { ...state.ui, stuckOverlaySessionId: action.sessionId } };
    case "DISMISS_STUCK_OVERLAY": {
      const newDismissed = new Set(state.ui.dismissedStuckSessions);
      if (state.ui.stuckOverlaySessionId) {
        newDismissed.add(state.ui.stuckOverlaySessionId);
      }
      return { ...state, ui: { ...state.ui, stuckOverlaySessionId: null, dismissedStuckSessions: newDismissed } };
    }
    case "SET_EXECUTION_MODE":
      return { ...state, executionModes: { ...state.executionModes, [action.sessionId]: action.mode } };
    case "SET_DEFAULT_MODE":
      return { ...state, defaultMode: action.mode };
    case "TOGGLE_FLOW_MODE":
      return { ...state, ui: { ...state.ui, flowMode: !state.ui.flowMode } };
    case "TOGGLE_TIMELINE":
      return { ...state, ui: { ...state.ui, timelineOpen: !state.ui.timelineOpen } };
    case "SHOW_AUTO_TOAST":
      return { ...state, ui: { ...state.ui, autoToast: { command: action.command, reason: action.reason, sessionId: action.sessionId } } };
    case "DISMISS_AUTO_TOAST":
      return { ...state, ui: { ...state.ui, autoToast: null } };
    case "TOGGLE_AUTO_APPLY":
      return { ...state, autoApplyEnabled: !state.autoApplyEnabled };
    case "SET_AUTONOMOUS_SETTINGS":
      return { ...state, autonomousSettings: { ...state.autonomousSettings, ...action.settings } };

    // ─── Layout Actions ───────────────────────────────────────────────
    case "INIT_PANE": {
      if (state.layout.root) {
        // Layout exists — if no pane shows this session, swap focused pane
        const existingPane = collectPanes(state.layout.root).find((p) => p.sessionId === action.sessionId);
        if (existingPane) {
          return {
            ...state,
            activeSessionId: action.sessionId,
            layout: { ...state.layout, focusedPaneId: existingPane.id },
          };
        }
        if (state.layout.focusedPaneId) {
          const swapped = setPaneSession(state.layout.root, state.layout.focusedPaneId, action.sessionId);
          return {
            ...state,
            activeSessionId: action.sessionId,
            layout: { ...state.layout, root: swapped },
          };
        }
        return state;
      }
      const paneId = nextPaneId();
      const pane: PaneLeaf = { type: "pane", id: paneId, sessionId: action.sessionId };
      return {
        ...state,
        activeSessionId: action.sessionId,
        layout: { root: pane, focusedPaneId: paneId },
      };
    }
    case "SPLIT_PANE": {
      if (!state.layout.root) return state;
      const newPaneId = nextPaneId();
      const newPane: PaneLeaf = { type: "pane", id: newPaneId, sessionId: action.newSessionId };
      const splitId = nextSplitId();
      const targetPanes = collectPanes(state.layout.root);
      const target = targetPanes.find((p) => p.id === action.paneId);
      if (!target) return state;
      const children: [LayoutNode, LayoutNode] = action.insertBefore
        ? [newPane, target]
        : [target, newPane];
      const splitNode: LayoutNode = {
        type: "split",
        id: splitId,
        direction: action.direction,
        children,
        ratio: 0.5,
      };
      const newRoot = replaceNode(state.layout.root, action.paneId, splitNode);
      return {
        ...state,
        activeSessionId: action.newSessionId,
        layout: { root: newRoot, focusedPaneId: newPaneId },
      };
    }
    case "CLOSE_PANE": {
      if (!state.layout.root) return state;
      const newRoot = removePane(state.layout.root, action.paneId);
      if (!newRoot) {
        return {
          ...state,
          layout: { root: null, focusedPaneId: null },
        };
      }
      const remainingPanes = collectPanes(newRoot);
      let newFocused = state.layout.focusedPaneId;
      if (newFocused === action.paneId || !remainingPanes.some((p) => p.id === newFocused)) {
        newFocused = remainingPanes.length > 0 ? remainingPanes[0].id : null;
      }
      const focusedP = remainingPanes.find((p) => p.id === newFocused);
      return {
        ...state,
        activeSessionId: focusedP ? focusedP.sessionId : state.activeSessionId,
        layout: { root: newRoot, focusedPaneId: newFocused },
      };
    }
    case "FOCUS_PANE": {
      if (!state.layout.root) return state;
      const allPanes = collectPanes(state.layout.root);
      const focused = allPanes.find((p) => p.id === action.paneId);
      return {
        ...state,
        activeSessionId: focused ? focused.sessionId : state.activeSessionId,
        layout: { ...state.layout, focusedPaneId: action.paneId },
      };
    }
    case "RESIZE_SPLIT": {
      if (!state.layout.root) return state;
      const resized = updateSplitRatio(state.layout.root, action.splitId, action.ratio);
      return {
        ...state,
        layout: { ...state.layout, root: resized },
      };
    }
    case "SET_PANE_SESSION": {
      if (!state.layout.root) return state;
      const updated = setPaneSession(state.layout.root, action.paneId, action.sessionId);
      return {
        ...state,
        activeSessionId: state.layout.focusedPaneId === action.paneId ? action.sessionId : state.activeSessionId,
        layout: { ...state.layout, root: updated },
      };
    }

    default:
      return state;
  }
}

/** @internal — exported for testing */
export const initialState: SessionState = {
  sessions: {},
  activeSessionId: null,
  recentSessions: [],
  defaultMode: "manual" as ExecutionMode,
  executionModes: {},
  autonomousSettings: {
    errorMinOccurrences: 3,
    commandMinFrequency: 5,
    cancelDelayMs: 3000,
  },
  autoApplyEnabled: true,
  layout: {
    root: null,
    focusedPaneId: null,
  },
  ui: {
    contextPanelOpen: true,
    sessionListCollapsed: false,
    commandPaletteOpen: false,
    stuckOverlaySessionId: null,
    dismissedStuckSessions: new Set(),
    flowMode: false,
    timelineOpen: false,
    autoToast: null,
  },
};

// ─── Context ────────────────────────────────────────────────────────

export interface CreateSessionOpts {
  label?: string;
  workingDirectory?: string;
  restoreFromId?: string;
  aiProvider?: string;
  realmIds?: string[];
}

interface SessionContextValue {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  createSession: (opts?: CreateSessionOpts) => Promise<SessionData | null>;
  closeSession: (id: string) => Promise<void>;
  setActive: (id: string | null) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const busyTimestamps = useRef<Map<string, number>>(new Map());
  const stuckNotified = useRef<Set<string>>(new Set());
  const nudgeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const closingSessionIds = useRef<Set<string>>(new Set());

  // Long-running threshold: 30 seconds of busy before notification on idle
  const LONG_RUNNING_THRESHOLD_MS = 30_000;

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // Initialize notifications on mount
    initNotifications().catch(console.warn);

    const setup = async () => {
      const u1 = await listen<SessionData>("session-updated", (event) => {
        const session = event.payload;
        dispatch({ type: "SESSION_UPDATED", session });

        // Auto-attach realm on working_directory change
        if (session.working_directory) {
          invoke("get_realms").then((realmsArr) => {
            const realms = realmsArr as { id: string; path: string }[];
            for (const realm of realms) {
              if (session.working_directory.startsWith(realm.path)) {
                // Check if already attached
                invoke("get_session_realms", { sessionId: session.id }).then((attached) => {
                  const attachedRealms = attached as { id: string }[];
                  if (!attachedRealms.some((r) => r.id === realm.id)) {
                    invoke("attach_session_realm", {
                      sessionId: session.id,
                      realmId: realm.id,
                      role: "primary",
                    }).catch((err) => console.warn("[SessionContext] Failed to attach realm:", err));
                  }
                }).catch((err) => console.warn("[SessionContext] Failed to check attached realms:", err));
                break;
              }
            }
          }).catch((err) => console.warn("[SessionContext] Failed to load realms for auto-attach:", err));
        }

        // Auto-cleanup destroyed sessions (PTY exited on its own)
        if (session.phase === "destroyed" && !closingSessionIds.current.has(session.id)) {
          closingSessionIds.current.add(session.id);
          invoke("close_session", { sessionId: session.id }).catch(() => {
            closingSessionIds.current.delete(session.id);
          });
          return;
        }

        // Track busy → idle transitions for long-running notifications
        if (session.phase === "busy") {
          if (!busyTimestamps.current.has(session.id)) {
            busyTimestamps.current.set(session.id, Date.now());
          }
        } else if (session.phase === "idle") {
          const startedAt = busyTimestamps.current.get(session.id);
          busyTimestamps.current.delete(session.id);
          if (startedAt && (Date.now() - startedAt) > LONG_RUNNING_THRESHOLD_MS) {
            // Only notify if the window is not focused
            if (document.hidden) {
              notifyLongRunningDone(session.label);
            }
          }
        }

        // Auto-show stuck overlay + notify (only if not dismissed for this session)
        if (session.metrics.stuck_score > 0.7) {
          dispatch({ type: "SHOW_STUCK_OVERLAY", sessionId: session.id });
          if (!stuckNotified.current.has(session.id)) {
            stuckNotified.current.add(session.id);
            if (document.hidden) {
              notifyStuck(session.label);
            }
          }
        } else {
          stuckNotified.current.delete(session.id);
        }
      });
      unlisteners.push(u1);

      const u2 = await listen<string>("session-removed", (event) => {
        destroyTerminal(event.payload);
        // Clean up nudge timer if one exists for this session
        const existingTimer = nudgeTimers.current.get(event.payload);
        if (existingTimer) {
          clearTimeout(existingTimer);
          nudgeTimers.current.delete(event.payload);
        }
        dispatch({ type: "SESSION_REMOVED", id: event.payload });
      });
      unlisteners.push(u2);

      // Debounced nudge when realms change mid-session (e.g. user adds/removes projects)
      const u3 = await listen<string>("session-realms-changed", (event) => {
        const sessionId = event.payload;
        const existing = nudgeTimers.current.get(sessionId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          nudgeTimers.current.delete(sessionId);
          invoke("nudge_realm_context", { sessionId }).catch((err) => console.warn("[SessionContext] Failed to nudge realm context:", err));
        }, 1500);
        nudgeTimers.current.set(sessionId, timer);
      });
      unlisteners.push(u3);
    };

    setup();

    // Load settings first, THEN sessions (so terminals use correct settings)
    invoke("get_settings")
      .then((settings) => {
        const s = settings as Record<string, string>;
        updateSettings(s);
        if (s.execution_mode === "assisted" || s.execution_mode === "autonomous") {
          dispatch({ type: "SET_DEFAULT_MODE", mode: s.execution_mode as ExecutionMode });
        }
        dispatch({
          type: "SET_AUTONOMOUS_SETTINGS",
          settings: {
            errorMinOccurrences: s.auto_error_min_occurrences ? parseInt(s.auto_error_min_occurrences, 10) || 3 : 3,
            commandMinFrequency: s.auto_command_min_frequency ? parseInt(s.auto_command_min_frequency, 10) || 5 : 5,
            cancelDelayMs: s.auto_cancel_delay_ms ? parseInt(s.auto_cancel_delay_ms, 10) || 3000 : 3000,
          },
        });

        // Now load sessions after settings are applied
        return invoke("get_sessions");
      })
      .then((sessions) => {
        const arr = sessions as SessionData[];
        arr.forEach((s) => {
          dispatch({ type: "SESSION_UPDATED", session: s });
          createTerminal(s.id, s.color);
        });
        // Auto-init layout for the first live session
        const live = arr.filter((s) => s.phase !== "destroyed");
        if (live.length > 0) {
          dispatch({ type: "SET_ACTIVE", id: live[0].id });
        }
      })
      .catch(console.error);

    invoke("get_recent_sessions", { limit: 10 })
      .then((entries) => dispatch({ type: "SET_RECENT", entries: entries as SessionHistoryEntry[] }))
      .catch(console.error);

    return () => { unlisteners.forEach((u) => u()); };
  }, []);

  // Filter stuck overlay through dismissed set (in SHOW_STUCK_OVERLAY dispatch check)
  // Done in a separate effect to avoid the reducer needing access to current state during event
  useEffect(() => {
    if (state.ui.stuckOverlaySessionId && state.ui.dismissedStuckSessions.has(state.ui.stuckOverlaySessionId)) {
      dispatch({ type: "DISMISS_STUCK_OVERLAY" });
    }
  }, [state.ui.stuckOverlaySessionId, state.ui.dismissedStuckSessions]);


  const createSession = useCallback(async (opts?: CreateSessionOpts) => {
    try {
      const session = await invoke("create_session", {
        label: opts?.label || null,
        workingDirectory: opts?.workingDirectory || null,
        color: null,
        workspacePaths: null,
        aiProvider: opts?.aiProvider || null,
        realmIds: opts?.realmIds || null,
      }) as SessionData;
      await createTerminal(session.id, session.color);

      // Restore scrollback from previous session if available
      if (opts?.restoreFromId) {
        try {
          const snapshot = await invoke("get_session_snapshot", { sessionId: opts.restoreFromId }) as string | null;
          if (snapshot) {
            writeScrollback(session.id, snapshot);
          }
        } catch {
          console.warn("[SessionContext] Failed to restore scrollback");
        }
      }

      dispatch({ type: "SESSION_UPDATED", session });
      dispatch({ type: "SET_ACTIVE", id: session.id });
      return session;
    } catch (err) {
      console.error("Failed to create session:", err);
      return null;
    }
  }, []);

  const closeSession = useCallback(async (id: string) => {
    try {
      await invoke("close_session", { sessionId: id });
    } catch (err) {
      console.error("Failed to close session:", err);
    }
  }, []);

  const setActive = useCallback((id: string | null) => {
    dispatch({ type: "SET_ACTIVE", id });
  }, []);

  return (
    <SessionContext.Provider value={{ state, dispatch, createSession, closeSession, setActive }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}

// ─── Derived hooks (memoized) ───────────────────────────────────────

export function useActiveSession(): SessionData | null {
  const { state } = useSession();
  return state.activeSessionId ? state.sessions[state.activeSessionId] ?? null : null;
}

export function useSessionList(): SessionData[] {
  const { state } = useSession();
  return useMemo(() => Object.values(state.sessions), [state.sessions]);
}

export function useTotalCost(): number {
  const { state } = useSession();
  return useMemo(() => {
    let total = 0;
    for (const session of Object.values(state.sessions)) {
      for (const tokens of Object.values(session.metrics.token_usage)) {
        total += tokens.estimated_cost_usd;
      }
    }
    return total;
  }, [state.sessions]);
}

export function useTotalTokens(): { input: number; output: number } {
  const { state } = useSession();
  return useMemo(() => {
    let input = 0, output = 0;
    for (const session of Object.values(state.sessions)) {
      for (const tokens of Object.values(session.metrics.token_usage)) {
        input += tokens.input_tokens;
        output += tokens.output_tokens;
      }
    }
    return { input, output };
  }, [state.sessions]);
}

export function useExecutionMode(sessionId: string | null): ExecutionMode {
  const { state } = useSession();
  if (!sessionId) return state.defaultMode;
  return state.executionModes[sessionId] || state.defaultMode;
}

export function useAutonomousSettings() {
  const { state } = useSession();
  return state.autonomousSettings;
}
