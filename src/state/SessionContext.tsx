import { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef, ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  createSession as apiCreateSession, closeSession as apiCloseSession,
  getSessions, getRecentSessions, getSessionSnapshot,
} from "../api/sessions";
import { getProjects, getSessionProjects, attachSessionProject, nudgeProjectContext } from "../api/projects";
import { createWorktree } from "../api/git";
import { getSettings, getSetting } from "../api/settings";
import { createTerminal, destroy as destroyTerminal, writeScrollback } from "../terminal/TerminalPool";
import { applyTheme } from "../utils/themeManager";
import { restoreWindowState } from "../utils/windowState";
import { initNotifications, notifyLongRunningDone } from "../utils/notifications";
import { initAnalytics, trackAppStarted, trackSessionCreated } from "../utils/analytics";
import {
  LayoutNode, PaneLeaf,
  nextPaneId, nextSplitId,
  replaceNode, removePane, collectPanes, updateSplitRatio,
  setPaneSession, removePanesBySession,
} from "./layoutTypes";

// ─── Re-export shared types for backward compatibility ──────────────
export type {
  AgentInfo, ToolCall, ProviderTokens, ActionEvent, ActionTemplate,
  MemoryFact, SessionMetrics, SessionData, SessionHistoryEntry,
  ExecutionNode, ExecutionMode, CreateSessionOpts, SessionAction,
} from "../types/session";

import type {
  SessionData, SessionHistoryEntry, ExecutionMode, CreateSessionOpts, SessionAction,
} from "../types/session";

// ─── State ──────────────────────────────────────────────────────────

interface SessionState {
  sessions: Record<string, SessionData>;
  activeSessionId: string | null;
  recentSessions: SessionHistoryEntry[];
  defaultMode: ExecutionMode;
  executionModes: Record<string, ExecutionMode>;
  autonomousSettings: {
    commandMinFrequency: number;
    cancelDelayMs: number;
  };
  autoApplyEnabled: boolean;
  injectionLocks: Record<string, boolean>;
  layout: {
    root: LayoutNode | null;
    focusedPaneId: string | null;
  };
  pendingCloseSessionId: string | null;
  skipCloseConfirm: boolean;
  ui: {
    contextPanelOpen: boolean;
    sessionListCollapsed: boolean;
    commandPaletteOpen: boolean;
    flowMode: boolean;
    timelineOpen: boolean;
    autoToast: { command: string; reason: string; sessionId: string } | null;
    processPanelOpen: boolean;
    gitPanelOpen: boolean;
    fileExplorerOpen: boolean;
    searchPanelOpen: boolean;
    composerOpen: boolean;
    activeLeftTab: "sessions" | "terminal" | "processes" | "git" | "files" | "search";
  };
}

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
      // Clean per-session execution mode and injection lock
      const { [action.id]: _mode, ...restModes } = state.executionModes;
      const { [action.id]: _lock, ...restLocks } = state.injectionLocks;
      // Clear autoToast if it references the removed session
      const newAutoToast = state.ui.autoToast?.sessionId === action.id
        ? null
        : state.ui.autoToast;
      // Clear pending close dialog if the removed session is the one being confirmed
      const newPendingClose = state.pendingCloseSessionId === action.id
        ? null
        : state.pendingCloseSessionId;
      // When no sessions remain, collapse all panels to show clean empty state
      const noSessionsLeft = ids.length === 0;
      return {
        ...state,
        sessions: rest,
        activeSessionId: newActive,
        executionModes: restModes,
        injectionLocks: restLocks,
        pendingCloseSessionId: newPendingClose,
        layout: { root: newRoot, focusedPaneId: newFocused },
        ui: {
          ...state.ui,
          autoToast: newAutoToast,
          ...(noSessionsLeft && {
            sessionListCollapsed: true,
            contextPanelOpen: false,
            processPanelOpen: false,
            gitPanelOpen: false,
            fileExplorerOpen: false,
            searchPanelOpen: false,
            timelineOpen: false,
          }),
        },
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
      return {
        ...state,
        ui: {
          ...state.ui,
          sessionListCollapsed: !state.ui.sessionListCollapsed,
          activeLeftTab: "terminal" as const,
          processPanelOpen: !state.ui.sessionListCollapsed ? state.ui.processPanelOpen : false,
          gitPanelOpen: !state.ui.sessionListCollapsed ? state.ui.gitPanelOpen : false,
          fileExplorerOpen: !state.ui.sessionListCollapsed ? state.ui.fileExplorerOpen : false,
          searchPanelOpen: !state.ui.sessionListCollapsed ? state.ui.searchPanelOpen : false,
        },
      };
    case "TOGGLE_PALETTE":
      return { ...state, ui: { ...state.ui, commandPaletteOpen: !state.ui.commandPaletteOpen } };
    case "CLOSE_PALETTE":
      return state.ui.commandPaletteOpen
        ? { ...state, ui: { ...state.ui, commandPaletteOpen: false } }
        : state;
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
    case "ACQUIRE_INJECTION_LOCK": {
      if (state.injectionLocks[action.sessionId]) return state; // Already locked
      return { ...state, injectionLocks: { ...state.injectionLocks, [action.sessionId]: true } };
    }
    case "RELEASE_INJECTION_LOCK": {
      const { [action.sessionId]: _, ...rest } = state.injectionLocks;
      return { ...state, injectionLocks: rest };
    }

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
          activeSessionId: null,
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

    // ─── Process panel actions ──────────────────────────────────────────
    case "TOGGLE_PROCESS_PANEL": {
      const opening = !state.ui.processPanelOpen;
      return {
        ...state,
        ui: {
          ...state.ui,
          processPanelOpen: opening,
          gitPanelOpen: opening ? false : state.ui.gitPanelOpen,
          fileExplorerOpen: opening ? false : state.ui.fileExplorerOpen,
          searchPanelOpen: opening ? false : state.ui.searchPanelOpen,
          activeLeftTab: opening ? "processes" : "sessions",
          sessionListCollapsed: opening ? true : state.ui.sessionListCollapsed,
        },
      };
    }
    case "SET_LEFT_TAB": {
      const tab = action.tab;
      // "terminal" closes all sidebar panels — full-width terminal
      if (tab === "terminal") {
        return {
          ...state,
          ui: {
            ...state.ui,
            activeLeftTab: "terminal",
            processPanelOpen: false,
            gitPanelOpen: false,
            fileExplorerOpen: false,
            searchPanelOpen: false,
            sessionListCollapsed: true,
          },
        };
      }
      const alreadyActive =
        (tab === "processes" && state.ui.processPanelOpen) ||
        (tab === "git" && state.ui.gitPanelOpen) ||
        (tab === "files" && state.ui.fileExplorerOpen) ||
        (tab === "search" && state.ui.searchPanelOpen) ||
        (tab === "sessions" && !state.ui.sessionListCollapsed && !state.ui.processPanelOpen && !state.ui.gitPanelOpen && !state.ui.fileExplorerOpen && !state.ui.searchPanelOpen);
      if (alreadyActive) {
        // Clicking the active tab collapses it → go to terminal view
        return {
          ...state,
          ui: {
            ...state.ui,
            processPanelOpen: false,
            gitPanelOpen: false,
            fileExplorerOpen: false,
            searchPanelOpen: false,
            sessionListCollapsed: true,
            activeLeftTab: "terminal",
          },
        };
      }
      return {
        ...state,
        ui: {
          ...state.ui,
          activeLeftTab: tab,
          processPanelOpen: tab === "processes",
          gitPanelOpen: tab === "git",
          fileExplorerOpen: tab === "files",
          searchPanelOpen: tab === "search",
          sessionListCollapsed: tab !== "sessions",
        },
      };
    }

    // ─── Git panel actions ──────────────────────────────────────────────
    case "TOGGLE_GIT_PANEL": {
      const opening = !state.ui.gitPanelOpen;
      return {
        ...state,
        ui: {
          ...state.ui,
          gitPanelOpen: opening,
          processPanelOpen: opening ? false : state.ui.processPanelOpen,
          fileExplorerOpen: opening ? false : state.ui.fileExplorerOpen,
          searchPanelOpen: opening ? false : state.ui.searchPanelOpen,
          activeLeftTab: opening ? "git" : "sessions",
          sessionListCollapsed: opening ? true : state.ui.sessionListCollapsed,
        },
      };
    }

    // ─── File explorer actions ──────────────────────────────────────────
    case "TOGGLE_FILE_EXPLORER": {
      const opening = !state.ui.fileExplorerOpen;
      return {
        ...state,
        ui: {
          ...state.ui,
          fileExplorerOpen: opening,
          processPanelOpen: opening ? false : state.ui.processPanelOpen,
          gitPanelOpen: opening ? false : state.ui.gitPanelOpen,
          searchPanelOpen: opening ? false : state.ui.searchPanelOpen,
          sessionListCollapsed: opening ? true : state.ui.sessionListCollapsed,
          activeLeftTab: opening ? "files" : "sessions",
        },
      };
    }

    // ─── Search panel actions ──────────────────────────────────────────
    case "TOGGLE_SEARCH_PANEL": {
      const opening = !state.ui.searchPanelOpen;
      return {
        ...state,
        ui: {
          ...state.ui,
          searchPanelOpen: opening,
          processPanelOpen: opening ? false : state.ui.processPanelOpen,
          gitPanelOpen: opening ? false : state.ui.gitPanelOpen,
          fileExplorerOpen: opening ? false : state.ui.fileExplorerOpen,
          sessionListCollapsed: opening ? true : state.ui.sessionListCollapsed,
          activeLeftTab: opening ? "search" : "sessions",
        },
      };
    }

    // ─── Sub-view panel (keeps session list visible) ──────────────────
    case "SET_SUBVIEW_PANEL": {
      const panel = action.panel;
      return {
        ...state,
        ui: {
          ...state.ui,
          gitPanelOpen: panel === "git",
          fileExplorerOpen: panel === "files",
          searchPanelOpen: panel === "search",
          processPanelOpen: false,
          // Session list stays open — don't touch sessionListCollapsed
          activeLeftTab: panel ?? "sessions",
        },
      };
    }

    // ─── Close confirmation actions ───────────────────────────────────
    case "REQUEST_CLOSE_SESSION":
      return { ...state, pendingCloseSessionId: action.id };
    case "CANCEL_CLOSE_SESSION":
      return { ...state, pendingCloseSessionId: null };
    case "SET_SKIP_CLOSE_CONFIRM":
      return { ...state, skipCloseConfirm: action.skip };

    // ─── Composer actions ────────────────────────────────────────────
    case "OPEN_COMPOSER":
      return { ...state, ui: { ...state.ui, composerOpen: true } };
    case "CLOSE_COMPOSER":
      return state.ui.composerOpen ? { ...state, ui: { ...state.ui, composerOpen: false } } : state;

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
    commandMinFrequency: 5,
    cancelDelayMs: 3000,
  },
  autoApplyEnabled: true,
  injectionLocks: {},
  pendingCloseSessionId: null,
  skipCloseConfirm: false,
  layout: {
    root: null,
    focusedPaneId: null,
  },
  ui: {
    contextPanelOpen: true,
    sessionListCollapsed: false,
    commandPaletteOpen: false,
    flowMode: false,
    timelineOpen: false,
    autoToast: null,
    processPanelOpen: false,
    gitPanelOpen: false,
    fileExplorerOpen: false,
    searchPanelOpen: false,
    composerOpen: false,
    activeLeftTab: "terminal" as const,
  },
};

// ─── Context ────────────────────────────────────────────────────────

interface SessionContextValue {
  state: SessionState;
  dispatch: React.Dispatch<SessionAction>;
  createSession: (opts?: CreateSessionOpts) => Promise<SessionData | null>;
  closeSession: (id: string) => Promise<void>;
  requestCloseSession: (id: string) => void;
  setActive: (id: string | null) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const busyTimestamps = useRef<Map<string, number>>(new Map());
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

        // Intercept destroyed phase: never show it in the UI.
        // Trigger cleanup and wait for SESSION_REMOVED instead.
        if (session.phase === "destroyed") {
          if (!closingSessionIds.current.has(session.id)) {
            closingSessionIds.current.add(session.id);
            apiCloseSession(session.id).catch(() => {
              closingSessionIds.current.delete(session.id);
            });
          }
          return;
        }

        dispatch({ type: "SESSION_UPDATED", session });

        // Auto-attach project on working_directory change
        // Uses exact path match with trailing separator to prevent
        // /home/user/app matching /home/user/app-legacy
        if (session.working_directory) {
          getProjects().then((projects) => {
            for (const project of projects) {
              const wd = session.working_directory;
              const rp = project.path;
              const isExactOrSubdir = wd === rp || wd.startsWith(rp + "/");
              if (isExactOrSubdir) {
                // Check if already attached
                getSessionProjects(session.id).then((attachedProjects) => {
                  if (!attachedProjects.some((r) => r.id === project.id)) {
                    attachSessionProject(session.id, project.id, "primary")
                      .catch((err) => console.warn("[SessionContext] Failed to attach project:", err));
                  }
                }).catch((err) => console.warn("[SessionContext] Failed to check attached projects:", err));
                break;
              }
            }
          }).catch((err) => console.warn("[SessionContext] Failed to load projects for auto-attach:", err));
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

      });
      unlisteners.push(u1);

      const u2 = await listen<string>("session-removed", (event) => {
        destroyTerminal(event.payload);
        // Clean up refs that track per-session state (prevent memory leaks)
        busyTimestamps.current.delete(event.payload);
        closingSessionIds.current.delete(event.payload);
        // Clean up nudge timer if one exists for this session
        const existingTimer = nudgeTimers.current.get(event.payload);
        if (existingTimer) {
          clearTimeout(existingTimer);
          nudgeTimers.current.delete(event.payload);
        }
        dispatch({ type: "SESSION_REMOVED", id: event.payload });
      });
      unlisteners.push(u2);

      // Debounced nudge when projects change mid-session (e.g. user adds/removes projects)
      const u3 = await listen<string>("session-realms-changed", (event) => {
        const sessionId = event.payload;
        const existing = nudgeTimers.current.get(sessionId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          nudgeTimers.current.delete(sessionId);
          nudgeProjectContext(sessionId).catch((err) => console.warn("[SessionContext] Failed to nudge project context:", err));
        }, 1500);
        nudgeTimers.current.set(sessionId, timer);
      });
      unlisteners.push(u3);
    };

    setup();

    // Load settings first, THEN sessions (so terminals use correct settings)
    getSettings()
      .then((s) => {
        applyTheme(s.theme || "tron", s);
        restoreWindowState(s).catch(console.error);
        initAnalytics().then(() => trackAppStarted());
        if (s.execution_mode === "assisted" || s.execution_mode === "autonomous") {
          dispatch({ type: "SET_DEFAULT_MODE", mode: s.execution_mode as ExecutionMode });
        }
        dispatch({
          type: "SET_AUTONOMOUS_SETTINGS",
          settings: {
            commandMinFrequency: s.auto_command_min_frequency ? parseInt(s.auto_command_min_frequency, 10) || 5 : 5,
            cancelDelayMs: s.auto_cancel_delay_ms ? parseInt(s.auto_cancel_delay_ms, 10) || 3000 : 3000,
          },
        });

        // Now load sessions after settings are applied
        return getSessions();
      })
      .then((arr) => {
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

    getRecentSessions(10)
      .then((entries) => dispatch({ type: "SET_RECENT", entries }))
      .catch(console.error);

    return () => { unlisteners.forEach((u) => u()); };
  }, []);

  const createSession = useCallback(async (opts?: CreateSessionOpts) => {
    try {
      // If a branch name and project (realm) are provided, pre-generate a
      // session ID and create the worktree first so the backend can look it
      // up and start the terminal in the worktree directory.
      let preSessionId = opts?.sessionId || null;
      if (opts?.branchName && opts?.projectIds?.length) {
        if (!preSessionId) {
          preSessionId = crypto.randomUUID();
        }
        try {
          await createWorktree(
            preSessionId,
            opts.projectIds[0],
            opts.branchName,
            opts.createNewBranch ?? false,
          );
        } catch (wtErr) {
          console.warn("[SessionContext] Failed to create worktree, session will use default cwd:", wtErr);
        }
      }

      const session = await apiCreateSession({
        sessionId: preSessionId,
        label: opts?.label || null,
        workingDirectory: opts?.workingDirectory || null,
        color: null,
        workspacePaths: null,
        aiProvider: opts?.aiProvider || null,
        realmIds: opts?.projectIds || null,
      });
      await createTerminal(session.id, session.color);

      // Restore scrollback from previous session if available
      if (opts?.restoreFromId) {
        try {
          const snapshot = await getSessionSnapshot(opts.restoreFromId);
          if (snapshot) {
            writeScrollback(session.id, snapshot);
          }
        } catch {
          console.warn("[SessionContext] Failed to restore scrollback");
        }
      }

      dispatch({ type: "SESSION_UPDATED", session });
      dispatch({ type: "SET_ACTIVE", id: session.id });
      trackSessionCreated({
        execution_mode: defaultModeRef.current,
        has_ai_provider: !!opts?.aiProvider,
      });
      return session;
    } catch (err) {
      console.error("Failed to create session:", err);
      return null;
    }
  }, []);

  const closeSession = useCallback(async (id: string) => {
    if (closingSessionIds.current.has(id)) return; // Prevent double-close race
    closingSessionIds.current.add(id);
    try {
      await apiCloseSession(id);
    } catch (err) {
      console.error("Failed to close session:", err);
      closingSessionIds.current.delete(id);
    }
  }, []);

  const defaultModeRef = useRef(state.defaultMode);
  defaultModeRef.current = state.defaultMode;

  const skipCloseConfirmRef = useRef(state.skipCloseConfirm);
  skipCloseConfirmRef.current = state.skipCloseConfirm;

  const requestCloseSession = useCallback((id: string) => {
    if (skipCloseConfirmRef.current) {
      closeSession(id);
    } else {
      dispatch({ type: "REQUEST_CLOSE_SESSION", id });
    }
  }, [closeSession, dispatch]);

  const setActive = useCallback((id: string | null) => {
    dispatch({ type: "SET_ACTIVE", id });
  }, []);

  // Load skip_close_confirm preference on mount
  useEffect(() => {
    getSetting("skip_close_confirm")
      .then((val) => {
        if (val === "true") {
          dispatch({ type: "SET_SKIP_CLOSE_CONFIRM", skip: true });
        }
      })
      .catch(() => { /* Setting not found — use default (false) */ });
  }, []);

  return (
    <SessionContext.Provider value={{ state, dispatch, createSession, closeSession, requestCloseSession, setActive }}>
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
