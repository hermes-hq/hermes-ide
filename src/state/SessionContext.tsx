import { createContext, useContext, useReducer, useEffect, useCallback, useMemo, useRef, useState, ReactNode } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent } from "../agent/types";
import { isInitEvent, isStateChangedEvent } from "../agent/types";

// Module-level guard to prevent React StrictMode from double-restoring sessions
let workspaceRestoreStarted = false;
// Guard to prevent periodic save from writing during workspace restore
let workspaceRestoreInProgress = false;
// Dirty flag — set when layout/sessions change in ways worth persisting.
// Cleared after each successful save. Prevents redundant saves every 10s.
let workspaceDirty = false;
import {
  createSession as apiCreateSession, closeSession as apiCloseSession,
  getSessions, getRecentSessions, getSessionSnapshot,
  updateSessionDescription, updateSessionGroup,
  saveAllSnapshots,
  addWorkspacePath,
} from "../api/sessions";
import { getProjects, getSessionProjects, attachSessionProject } from "../api/projects";
import { autoAttachInsideProject } from "../utils/autoAttach";
import { hasAddDirDrift } from "../utils/agentDrift";
import { createWorktree, worktreeHasChanges, stashWorktree, getSessionWorktreeInfo } from "../api/git";
import { getSettings, getSetting, setSetting } from "../api/settings";
import { createTerminal, destroy as destroyTerminal, writeScrollback, estimateInitialDimensions } from "../terminal/TerminalPool";
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
import { DirtyWorktreeDialog } from "../components/DirtyWorktreeDialog";
import type { DirtyWorktreeChange } from "../components/DirtyWorktreeDialog";

// ─── Re-export shared types for backward compatibility ──────────────
export type {
  AgentInfo, ToolCall, ProviderTokens, ActionEvent, ActionTemplate,
  MemoryFact, SessionMetrics, SessionData, SessionHistoryEntry,
  ExecutionMode, CreateSessionOpts, SessionAction, SessionMode,
} from "../types/session";

import type {
  SessionData, SessionHistoryEntry, ExecutionMode, CreateSessionOpts, SessionAction,
  SavedWorkspace, SavedSessionInfo, SessionMode,
} from "../types/session";
import { SAVED_WORKSPACE_VERSION, validateSavedWorkspace } from "../types/session";
import { spawnAgentSession, closeAgentSession, sendAgentInput, updateHermesState } from "../api/agent";
import {
  buildUserEnvelope,
  echoUserEnvelope,
  sendUserEnvelope,
  type AgentAttachment,
} from "../utils/submitToAgent";
import { sendAgentEnvelopeWithRevive } from "../utils/sendAgentEnvelope";

// ─── Workspace Restore Helpers ───────────────────────────────────────

/** Deep-clone a LayoutNode tree, replacing old session IDs with new ones.
 *  Gracefully handles malformed layout data that doesn't match the expected shape. */
function remapLayoutSessionIds(node: LayoutNode, oldToNew: Map<string, string>): LayoutNode | null {
  if (!node || typeof node !== "object" || !node.type) return null;

  if (node.type === "pane") {
    if (typeof (node as PaneLeaf).sessionId !== "string") return null;
    const newId = oldToNew.get((node as PaneLeaf).sessionId);
    if (!newId) return null; // Session wasn't restored — remove this pane
    return { ...node, id: nextPaneId(), sessionId: newId };
  }

  if (node.type === "split") {
    const split = node as { children?: unknown[] };
    if (!Array.isArray(split.children) || split.children.length < 2) return null;
    const left = remapLayoutSessionIds(split.children[0] as LayoutNode, oldToNew);
    const right = remapLayoutSessionIds(split.children[1] as LayoutNode, oldToNew);
    if (!left && !right) return null;
    if (!left) return right;
    if (!right) return left;
    return {
      ...node,
      id: nextSplitId(),
      children: [left, right],
    };
  }

  // Unknown node type — skip
  return null;
}

/** The focused pane ID gets regenerated, so find the first pane in the tree. */
function remapPaneFocusId(layout: LayoutNode, _oldFocusId: string | null): string | null {
  // After remapping, IDs are fresh — just pick the first pane
  if (layout.type === "pane") return layout.id;
  return remapPaneFocusId(layout.children[0], _oldFocusId);
}

// ─── Session Mode Helpers ───────────────────────────────────────────

/**
 * Resolve the runtime mode for a new session.
 *
 * Rules (1.0.0 — agent mode is Claude-only):
 *   1. Non-Claude providers (and shell-only) are always "terminal".
 *   2. Claude defaults to "agent" unless the caller explicitly passed "terminal".
 *
 * Exported for testability.
 */
export function resolveSessionMode(
  requested: SessionMode | undefined,
  aiProvider: string | null | undefined,
): SessionMode {
  if (aiProvider !== "claude") return "terminal";
  return requested ?? "agent";
}

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
  composers: Record<string, { draft: string; height: number; expanded: boolean }>;
  layout: {
    root: LayoutNode | null;
    focusedPaneId: string | null;
  };
  pendingCloseSessionId: string | null;
  skipCloseConfirm: boolean;
  ui: {
    contextPanelOpen: boolean;
    /** Usage panel — shows account info + rate limits + per-session cost.
     *  Lives on the right activity bar, below the Context tab. */
    usagePanelOpen: boolean;
    sessionListCollapsed: boolean;
    commandPaletteOpen: boolean;
    flowMode: boolean;
    autoToast: { command: string; reason: string; sessionId: string } | null;
    processPanelOpen: boolean;
    gitPanelOpen: boolean;
    fileExplorerOpen: boolean;
    searchPanelOpen: boolean;
    composerOpen: boolean;
    activeLeftTab: "sessions" | "terminal" | "processes" | "git" | "files" | "search";
    filePreview: { projectId: string; filePath: string } | null;
  };
}

/** Mode-aware default for a fresh composer entry.  Mirrors `useComposer`:
 *  agent sessions default to expanded (the composer IS the input surface);
 *  terminal sessions default to collapsed (the composer is a side dock).
 *  Used inside the reducer when a SET_COMPOSER_* action arrives before the
 *  user has explicitly opened/closed the composer. */
function defaultComposerEntry(
  state: SessionState,
  sessionId: string,
): { draft: string; height: number; expanded: boolean } {
  const session = state.sessions[sessionId];
  return { draft: "", height: 120, expanded: session?.mode === "agent" };
}

/** @internal — exported for testing */
export function sessionReducer(state: SessionState, action: SessionAction): SessionState {
  switch (action.type) {
    case "SESSION_UPDATED": {
      const existing = state.sessions[action.session.id];
      // Skip update if the session data hasn't meaningfully changed —
      // prevents cascading re-renders from high-frequency backend emissions.
      if (existing
        && existing.phase === action.session.phase
        && existing.last_activity_at === action.session.last_activity_at
        && existing.working_directory === action.session.working_directory
        && existing.context_injected === action.session.context_injected
        && existing.label === action.session.label
        && existing.color === action.session.color
        && existing.group === action.session.group
        && existing.description === action.session.description
        && existing.detected_agent?.name === action.session.detected_agent?.name
        && existing.detected_agent?.model === action.session.detected_agent?.model
        && existing.metrics.output_lines === action.session.metrics.output_lines
        && existing.metrics.tool_calls.length === action.session.metrics.tool_calls.length
        && existing.metrics.files_touched.length === action.session.metrics.files_touched.length
        && existing.metrics.memory_facts.length === action.session.metrics.memory_facts.length
        // Multi-folder bug fix: workspace_paths drives the agent's --add-dir
        // sandbox AND the Hermes MCP `list_projects` view.  Compared as a
        // SET — the SDK's additionalDirectories is order-insensitive, so a
        // pure reorder is a no-op state update (kept reference-equal so
        // React doesn't re-render unrelated subtrees).  Real adds/removes
        // still register and propagate.
        && !hasAddDirDrift(existing.workspace_paths, action.session.workspace_paths)
      ) {
        return state;
      }
      workspaceDirty = true;
      return {
        ...state,
        sessions: { ...state.sessions, [action.session.id]: action.session },
      };
    }
    case "SESSION_REMOVED": {
      workspaceDirty = true;
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
      const { [action.id]: _composer, ...restComposers } = state.composers;
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
        composers: restComposers,
        pendingCloseSessionId: newPendingClose,
        layout: { root: newRoot, focusedPaneId: newFocused },
        ui: {
          ...state.ui,
          autoToast: newAutoToast,
          ...(noSessionsLeft && {
            sessionListCollapsed: true,
            contextPanelOpen: false,
            usagePanelOpen: false,
            processPanelOpen: false,
            gitPanelOpen: false,
            fileExplorerOpen: false,
            searchPanelOpen: false,
          }),
        },
      };
    }
    case "SET_ACTIVE": {
      workspaceDirty = true;
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
      // Right rail is single-panel: opening Context closes Usage.
      return {
        ...state,
        ui: {
          ...state.ui,
          contextPanelOpen: !state.ui.contextPanelOpen,
          usagePanelOpen: state.ui.contextPanelOpen ? state.ui.usagePanelOpen : false,
        },
      };
    case "TOGGLE_USAGE":
      return {
        ...state,
        ui: {
          ...state.ui,
          usagePanelOpen: !state.ui.usagePanelOpen,
          contextPanelOpen: state.ui.usagePanelOpen ? state.ui.contextPanelOpen : false,
        },
      };
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
    case "SET_SESSION_MODE": {
      const existing = state.sessions[action.sessionId];
      if (!existing || existing.mode === action.mode) return state;
      workspaceDirty = true;
      return {
        ...state,
        sessions: {
          ...state.sessions,
          [action.sessionId]: { ...existing, mode: action.mode },
        },
      };
    }
    case "TOGGLE_FLOW_MODE":
      return { ...state, ui: { ...state.ui, flowMode: !state.ui.flowMode } };
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
    case "SET_COMPOSER_DRAFT": {
      const prev = state.composers[action.sessionId] ?? defaultComposerEntry(state, action.sessionId);
      return {
        ...state,
        composers: {
          ...state.composers,
          [action.sessionId]: { ...prev, draft: action.draft },
        },
      };
    }
    case "SET_COMPOSER_HEIGHT": {
      const prev = state.composers[action.sessionId] ?? defaultComposerEntry(state, action.sessionId);
      return {
        ...state,
        composers: {
          ...state.composers,
          [action.sessionId]: { ...prev, height: action.height },
        },
      };
    }
    case "TOGGLE_COMPOSER_EXPANDED": {
      const prev = state.composers[action.sessionId] ?? defaultComposerEntry(state, action.sessionId);
      workspaceDirty = true;
      return {
        ...state,
        composers: {
          ...state.composers,
          [action.sessionId]: { ...prev, expanded: !prev.expanded },
        },
      };
    }
    case "SET_COMPOSER_EXPANDED": {
      const prev = state.composers[action.sessionId] ?? defaultComposerEntry(state, action.sessionId);
      if (prev.expanded === action.expanded) return state;
      workspaceDirty = true;
      return {
        ...state,
        composers: {
          ...state.composers,
          [action.sessionId]: { ...prev, expanded: action.expanded },
        },
      };
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
      workspaceDirty = true;
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
      workspaceDirty = true;
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

    // ─── File preview actions ─────────────────────────────────────────
    case "SET_FILE_PREVIEW":
      return { ...state, ui: { ...state.ui, filePreview: { projectId: action.projectId, filePath: action.filePath } } };
    case "CLOSE_FILE_PREVIEW":
      return state.ui.filePreview ? { ...state, ui: { ...state.ui, filePreview: null } } : state;

    // ─── Workspace restore actions ───────────────────────────────────
    case "RESTORE_LAYOUT":
      return {
        ...state,
        activeSessionId: action.activeSessionId,
        layout: { root: action.root as LayoutNode | null, focusedPaneId: action.focusedPaneId },
      };

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
  composers: {},
  pendingCloseSessionId: null,
  skipCloseConfirm: false,
  layout: {
    root: null,
    focusedPaneId: null,
  },
  ui: {
    // Closed by default — the conversation gets the full horizontal
    // room.  The activity-bar Context button (Cmd/Ctrl+E) opens the
    // panel on demand.  Earlier default-open landed in #261 but felt
    // claustrophobic when the Sessions sidebar was also open; the
    // user prefers to start clean and reach for the panel only when
    // they need it.
    contextPanelOpen: false,
    usagePanelOpen: false,
    sessionListCollapsed: false,
    commandPaletteOpen: false,
    flowMode: false,
    autoToast: null,
    processPanelOpen: false,
    gitPanelOpen: false,
    fileExplorerOpen: false,
    searchPanelOpen: false,
    composerOpen: false,
    activeLeftTab: "terminal" as const,
    filePreview: null,
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
  saveWorkspace: () => Promise<void>;
  /** Convert a live session between "terminal" and "agent" mode.
   *  Tears down the previous-mode subprocess, dispatches `SET_SESSION_MODE`,
   *  and spawns the new-mode subprocess.  Returns true on success.
   *  The conversation history of the previous mode is NOT preserved. */
  convertSessionMode: (sessionId: string, newMode: SessionMode) => Promise<boolean>;
  /** Switch the model on a live agent-mode session.  Tears down the Claude
   *  subprocess and respawns with `--model <id>` + `--resume <prior-uuid>`,
   *  so the conversation history is preserved across the swap.  Returns
   *  true on success.  No-op when the session isn't agent-mode. */
  switchAgentModel: (sessionId: string, model: string | null) => Promise<boolean>;
  /** Switch Claude's `--permission-mode` on a live agent-mode session.
   *  Same teardown+respawn-with-resume mechanic as `switchAgentModel`.
   *  Accepts: "default" | "acceptEdits" | "plan" | "bypassPermissions". */
  switchAgentPermissionMode: (sessionId: string, mode: string | null) => Promise<boolean>;
  /** Switch Claude's `--effort` on a live agent-mode session.  Same
   *  fork-on-respawn pattern.  Accepts: "low" | "medium" | "high" | "xhigh"
   *  | "max", or null to drop the flag. */
  switchAgentEffort: (sessionId: string, effort: string | null) => Promise<boolean>;
  /** Submit a user message to an agent session, auto-respawning Claude's
   *  one-shot subprocess with `--resume <uuid>` if it has exited between
   *  turns.  The composer should call this rather than `submitToAgent`
   *  directly so the multi-turn flow stays alive. */
  submitAgentMessage: (
    sessionId: string,
    draft: string,
    attachments: AgentAttachment[],
  ) => Promise<void>;
  /** Send an arbitrary envelope (e.g. a `tool_result` for AskUserQuestion
   *  or ExitPlanMode, or a `_hermes_perm_response` for canUseTool) to
   *  the agent.  Wraps `send_agent_input` with a respawn-on-not-found
   *  retry so interactive tool replies aren't dropped between turns
   *  when the bridge subprocess has exited.  See M10. */
  sendAgentEnvelope: (sessionId: string, envelope: unknown) => Promise<void>;
  /** Tear down the live bridge subprocess and respawn it with the same
   *  flags + `--resume <prior-uuid>`.  Used when the on-disk config
   *  the bridge consumed (MCP servers, permission rules) has changed
   *  out from under it and we need the SDK to re-read it.  Returns
   *  true on a successful respawn. */
  respawnAgent: (sessionId: string) => Promise<boolean>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  const busyTimestamps = useRef<Map<string, number>>(new Map());
  const lastAutoAttachCwd = useRef<Map<string, string>>(new Map());
  const closingSessionIds = useRef<Set<string>>(new Set());
  const closeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /** sessionId → Claude session UUID returned by spawn_agent_session.
   *  Captured on first spawn (and on every successful respawn) so that a
   *  later model swap can pass `--resume <uuid>` to preserve conversation. */
  const claudeUuids = useRef<Map<string, string>>(new Map());
  /** sessionId → currently-active model alias (or undefined for default).
   *  Used so a permission-mode swap doesn't accidentally drop the model
   *  the user previously selected, and vice versa. */
  const claudeModels = useRef<Map<string, string | undefined>>(new Map());
  /** sessionId → currently-active permission mode (Claude's `--permission-mode`
   *  value).  Same role as `claudeModels` — preserved across respawns. */
  const claudePermissionModes = useRef<Map<string, string | undefined>>(new Map());
  /** sessionId → currently-active `--effort` value (low/medium/high/xhigh/max).
   *  Preserved across respawns alongside model + permission mode. */
  const claudeEfforts = useRef<Map<string, string | undefined>>(new Map());
  /** sessionId → snapshot of `--add-dir` values the bridge was last
   *  spawned with.  When the user attaches/detaches a project, the live
   *  session.workspace_paths drifts from this — submitAgentMessage
   *  detects the diff and triggers a respawn so Read/Edit tools can
   *  actually access files in newly-attached paths. */
  const claudeAddDirs = useRef<Map<string, string[]>>(new Map());
  /** sessionId → flag changes the user has *requested* but not yet applied,
   *  because applying them requires a fresh fork-respawn AND a user message
   *  for the new subprocess to actually persist its session.
   *
   *  This is the production-bug fix.  Forking with empty stdin makes
   *  Claude exit immediately without persisting the new session id, so the
   *  next `--resume <fork-uuid>` legitimately fails with "No conversation
   *  found".  We dodge that by queuing the flag change here on chip-click,
   *  then applying it inside `submitAgentMessage` right before the user's
   *  envelope hits stdin — guaranteeing the fork has work to do. */
  const pendingFlags = useRef<
    Map<string, { model?: string | null; permissionMode?: string | null; effort?: string | null }>
  >(new Map());

  /** Merge a new partial flag override into the queued bag for `sessionId`. */
  const queuePendingFlag = useCallback((
    sessionId: string,
    patch: { model?: string | null; permissionMode?: string | null; effort?: string | null },
  ) => {
    const cur = pendingFlags.current.get(sessionId) ?? {};
    pendingFlags.current.set(sessionId, { ...cur, ...patch });
  }, []);
  /** sessionId → unlisten function for the per-session agent-event listener
   *  that keeps `claudeUuids` in sync with whatever id Claude reports in its
   *  init event.  This is the defensive capture: even if our `--session-id`
   *  isn't honored, we'll always have the canonical id Claude actually
   *  persisted under, so `--resume` finds the conversation. */
  const initListeners = useRef<Map<string, UnlistenFn>>(new Map());

  /** Subscribe to agent-event-{sessionId} and keep `claudeUuids` /
   *  `claudeModels` / `claudePermissionModes` synced with whatever the
   *  bridge reports.  Two event kinds matter:
   *
   *    - `system/init` — emitted on spawn/resume.  Latches the canonical
   *      Claude-side session id so `--resume` works after exits.
   *    - `_hermes_state_changed` — emitted by the bridge whenever the
   *      live runtime model or permissionMode drifts (EnterPlanMode /
   *      ExitPlanMode / `/model`).  We mirror those into the per-session
   *      refs so the *next* respawn re-applies the new value rather than
   *      reverting to a stale UI selection.
   *
   *  Idempotent — calling twice for the same session is a no-op. */
  const attachInitListener = useCallback(async (sessionId: string) => {
    if (initListeners.current.has(sessionId)) return;
    try {
      const unlisten = await listen<AgentEvent>(
        `agent-event-${sessionId}`,
        (msg) => {
          const event = msg.payload;
          if (isInitEvent(event) && typeof event.session_id === "string") {
            const prior = claudeUuids.current.get(sessionId);
            console.log(
              `[init] model=${event.model ?? "?"} session=${event.session_id}` +
              ` prior=${prior ?? "<none>"} changed=${prior !== event.session_id}` +
              ` perm=${(event as { permissionMode?: string }).permissionMode ?? "?"}`,
            );
            claudeUuids.current.set(sessionId, event.session_id);
            // Init also reports the current model/perm — seed the refs
            // so the picker's chip reflects spawn-time values immediately
            // (before any state-changed event has fired).
            if (typeof event.model === "string") {
              claudeModels.current.set(sessionId, event.model);
            }
            if (typeof event.permissionMode === "string") {
              claudePermissionModes.current.set(sessionId, event.permissionMode);
            }
          } else if (isStateChangedEvent(event)) {
            console.log(
              `[state-changed] sid=${sessionId} model=${event.model ?? "?"}` +
              ` perm=${event.permissionMode ?? "?"}`,
            );
            if (typeof event.model === "string") {
              claudeModels.current.set(sessionId, event.model);
            }
            if (typeof event.permissionMode === "string") {
              claudePermissionModes.current.set(sessionId, event.permissionMode);
            }
          }
        },
      );
      initListeners.current.set(sessionId, unlisten);
    } catch (err) {
      console.warn("[SessionContext] failed to attach init listener:", err);
    }
  }, []);

  /** Unsubscribe — called on session removal. */
  const detachInitListener = useCallback((sessionId: string) => {
    const fn = initListeners.current.get(sessionId);
    if (fn) {
      try { fn(); } catch { /* ignore */ }
      initListeners.current.delete(sessionId);
    }
  }, []);

  // ─── Dirty worktree close state ─────────────────────────────────────
  const [pendingDirtyClose, setPendingDirtyClose] = useState<{
    sessionId: string;
    label: string;
    changes: DirtyWorktreeChange[];
    stashErrors?: Array<{ projectName: string; error: string }>;
  } | null>(null);

  // Long-running threshold: 30 seconds of busy before notification on idle
  const LONG_RUNNING_THRESHOLD_MS = 30_000;

  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    // Initialize notifications on mount
    initNotifications().catch(console.warn);

    // Initialize analytics (opt-in, default off)
    initAnalytics().then(() => trackAppStarted()).catch(console.warn);

    const setup = async () => {
      const u1 = await listen<SessionData>("session-updated", (event) => {
        const session = event.payload;

        // Intercept destroyed phase: never show it in the UI.
        // Trigger cleanup and wait for SESSION_REMOVED instead.
        // Disconnected SSH sessions are kept in the UI for reconnection.
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

        // Auto-attach project on working_directory change.  Exact path
        // match with trailing separator prevents /home/user/app matching
        // /home/user/app-legacy.  For agent-mode sessions the helper
        // also folds the project path into workspace_paths so the SDK
        // gets a corresponding `--add-dir` on its next respawn — without
        // that fold, "Claude can't see folder A" was the visible bug.
        const prevCwd = lastAutoAttachCwd.current.get(session.id);
        if (session.working_directory && session.working_directory !== prevCwd) {
          lastAutoAttachCwd.current.set(session.id, session.working_directory);
          autoAttachInsideProject(session, {
            getProjects,
            getSessionProjects,
            attachSessionProject,
            addWorkspacePath,
          }).catch((err) => console.warn("[SessionContext] auto-attach failed:", err));
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

      // Lightweight workspace_paths update — emitted by Rust's
      // add_workspace_path / remove_workspace_path for agent-mode sessions
      // where there's no PtySession in memory to mutate (and therefore no
      // full session-updated event to fire).  We merge the new paths into
      // the existing session in React state so the next composer submit's
      // drift detection sees the correct add-dirs and respawns the SDK.
      const uWp = await listen<{ session_id: string; workspace_paths: string[] }>(
        "session-workspace-paths-updated",
        (event) => {
          const { session_id, workspace_paths } = event.payload;
          console.log(
            `[wp-event] sid=${session_id} paths=${JSON.stringify(workspace_paths)}`,
          );
          const existing = stateRef.current.sessions[session_id];
          if (!existing) {
            console.warn(`[wp-event] no React session for ${session_id}`);
            return;
          }
          dispatch({
            type: "SESSION_UPDATED",
            session: { ...existing, workspace_paths },
          });
        },
      );
      unlisteners.push(uWp);

      // Lightweight metadata-update event from Rust's update_session_label,
      // update_session_description, update_session_color, update_session_group
      // — emitted ONLY for agent-mode sessions (no PtySession to mutate).
      // Terminal-mode keeps emitting the full `session-updated` shape from
      // in-memory state.  Each field is optional; merge non-undefined ones
      // into the existing session.
      const uMeta = await listen<{
        session_id: string;
        label?: string;
        description?: string;
        color?: string;
        // Outer Option<Option<String>>: presence means "field changed",
        // null inner means "group was cleared".
        group?: string | null;
      }>("session-metadata-updated", (event) => {
        const { session_id, label, description, color, group } = event.payload;
        const existing = stateRef.current.sessions[session_id];
        if (!existing) {
          console.warn(`[meta-event] no React session for ${session_id}`);
          return;
        }
        dispatch({
          type: "SESSION_UPDATED",
          session: {
            ...existing,
            ...(label !== undefined ? { label } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(group !== undefined ? { group: group ?? null } : {}),
          },
        });
      });
      unlisteners.push(uMeta);

      const u2 = await listen<string>("session-removed", (event) => {
        destroyTerminal(event.payload);
        // Clean up refs that track per-session state (prevent memory leaks)
        busyTimestamps.current.delete(event.payload);
        closingSessionIds.current.delete(event.payload);
        // Drop the per-session agent-event listener and per-session flag refs.
        detachInitListener(event.payload);
        claudeUuids.current.delete(event.payload);
        claudeModels.current.delete(event.payload);
        claudePermissionModes.current.delete(event.payload);
        claudeEfforts.current.delete(event.payload);
        pendingFlags.current.delete(event.payload);
        dispatch({ type: "SESSION_REMOVED", id: event.payload });
      });
      unlisteners.push(u2);

      // Note: project context nudge is now handled by ProjectPicker on close,
      // to avoid duplicate instructions when toggling multiple projects.
    };

    setup().catch((err) => console.error("[SessionContext] Failed to setup event listeners:", err));

    // Load settings first, THEN sessions (so terminals use correct settings)
    getSettings()
      .then((s) => {
        const theme = s.theme || "frosted-dark";
        applyTheme(theme, s);
        restoreWindowState(s).catch(console.error);
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
        return getSessions().then((arr) => ({ arr, settings: s }));
      })
      .then(async ({ arr, settings: s }) => {
        arr.forEach((session) => {
          dispatch({ type: "SESSION_UPDATED", session });
          createTerminal(session.id, session.color);
        });

        const live = arr.filter((session) => session.phase !== "destroyed");

        // If there are live sessions (hot reload / dev), use them as-is
        if (live.length > 0) {
          dispatch({ type: "SET_ACTIVE", id: live[0].id });
          return;
        }

        // No live sessions — attempt workspace restore
        const restorePref = s.restore_sessions || "always";
        const savedJson = s.saved_workspace;
        if (restorePref === "never" || !savedJson) return;

        // Guard against React StrictMode double-mount
        if (workspaceRestoreStarted) return;
        workspaceRestoreStarted = true;
        workspaceRestoreInProgress = true;

        try {
          let parsed: unknown;
          try {
            parsed = JSON.parse(savedJson);
          } catch {
            console.warn("[SessionContext] Corrupt workspace JSON — skipping restore");
            return;
          }

          // Validate structure before using it
          const workspace = validateSavedWorkspace(parsed);
          if (!workspace) {
            console.warn("[SessionContext] Invalid workspace structure — skipping restore");
            return;
          }

          // DO NOT clear saved_workspace here — keep it as backup until restore completes.
          // If the app crashes mid-restore, the next launch can retry from the same data.

          // Re-create each saved session
          const oldToNew = new Map<string, string>();
          for (const saved of workspace.sessions) {
            const restoreId = crypto.randomUUID();
            try {
              // Pre-generate ID and set up listener before PTY starts
              // (same race-prevention as createSession above)
              await createTerminal(restoreId, saved.color);

              const restoreDims = estimateInitialDimensions();
              // Default missing `mode` to "terminal" so existing 0.6.16 saved
              // workspaces never silently auto-convert sessions to agent mode.
              const restoredMode: SessionMode = saved.mode ?? "terminal";
              const newSession = await apiCreateSession({
                sessionId: restoreId,
                label: saved.label,
                workingDirectory: saved.working_directory,
                color: saved.color,
                workspacePaths: null,
                aiProvider: saved.ai_provider,
                projectIds: saved.project_ids.length > 0 ? saved.project_ids : null,
                autoApprove: saved.auto_approve ?? false,
                permissionMode: saved.permission_mode ?? (saved.auto_approve ? "bypassPermissions" : "default"),
                customPrefix: saved.custom_prefix ?? "",
                customSuffix: saved.custom_suffix ?? "",
                sshHost: saved.ssh_info?.host || null,
                sshPort: saved.ssh_info?.port || null,
                sshUser: saved.ssh_info?.user || null,
                tmuxSession: saved.ssh_info?.tmux_session || null,
                sshIdentityFile: saved.ssh_info?.identity_file || null,
                initialRows: restoreDims.rows,
                initialCols: restoreDims.cols,
                mode: restoredMode,
              });

              // Agent-mode restore: spawn the Claude subprocess that the
              // backend `create_session` deliberately skipped.  Honor the
              // last-active agent state from the saved workspace so the
              // user picks up exactly where they left off — same model,
              // same permission mode, same effort, same conversation
              // (via `--resume <claude_session_uuid>`).
              if (restoredMode === "agent") {
                void attachInitListener(newSession.id);
                // Pre-seed the per-session refs so subsequent flag toggles
                // build on the restored state rather than overwriting it.
                if (saved.agent_model) claudeModels.current.set(newSession.id, saved.agent_model);
                if (saved.agent_permission_mode) claudePermissionModes.current.set(newSession.id, saved.agent_permission_mode);
                if (saved.agent_effort) claudeEfforts.current.set(newSession.id, saved.agent_effort);
                const restoredDirs = saved.agent_add_dirs ?? newSession.workspace_paths;
                claudeAddDirs.current.set(newSession.id, [...restoredDirs]);
                spawnAgentSession({
                  sessionId: newSession.id,
                  workingDir: newSession.working_directory,
                  priorUuid: saved.claude_session_uuid,
                  model: saved.agent_model,
                  permissionMode: saved.agent_permission_mode,
                  effort: saved.agent_effort,
                  addDirs: restoredDirs,
                })
                  .then((uuid) => { claudeUuids.current.set(newSession.id, uuid); })
                  .catch((err) => {
                    console.error("[SessionContext] Failed to spawn Claude agent on restore:", err);
                  });
              }

              // Restore description and group — await them to ensure they persist
              const metaPromises: Promise<void>[] = [];
              if (saved.description) {
                metaPromises.push(
                  updateSessionDescription(newSession.id, saved.description)
                    .then(() => { newSession.description = saved.description; })
                    .catch((err) => console.warn("[SessionContext] Failed to restore description:", err))
                );
              }
              if (saved.group) {
                metaPromises.push(
                  updateSessionGroup(newSession.id, saved.group)
                    .then(() => { newSession.group = saved.group; })
                    .catch((err) => console.warn("[SessionContext] Failed to restore group:", err))
                );
              }
              await Promise.all(metaPromises);

              // Restore scrollback from the old session's snapshot
              try {
                const snapshot = await getSessionSnapshot(saved.id);
                if (snapshot) {
                  writeScrollback(newSession.id, snapshot);
                }
              } catch {
                console.warn("[SessionContext] Failed to restore scrollback for", saved.label);
              }

              dispatch({ type: "SESSION_UPDATED", session: newSession });
              oldToNew.set(saved.id, newSession.id);
            } catch (err) {
              console.warn("[SessionContext] Failed to restore session:", saved.label, err);
              // Clean up the terminal that was pre-created for this failed session
              destroyTerminal(restoreId);
            }
          }

          if (oldToNew.size === 0) return;

          // Rebuild the layout with remapped session IDs
          if (workspace.layout) {
            const remappedLayout = remapLayoutSessionIds(workspace.layout as LayoutNode, oldToNew);
            const remappedFocus = remappedLayout ? remapPaneFocusId(remappedLayout, workspace.focused_pane_id) : null;
            const remappedActive = workspace.active_session_id ? (oldToNew.get(workspace.active_session_id) ?? null) : null;
            dispatch({
              type: "RESTORE_LAYOUT",
              root: remappedLayout,
              focusedPaneId: remappedFocus,
              activeSessionId: remappedActive || oldToNew.values().next().value || null,
            });
          } else {
            // No layout saved — just activate the first restored session
            const firstNewId = oldToNew.values().next().value;
            if (firstNewId) dispatch({ type: "SET_ACTIVE", id: firstNewId });
          }

          // Restore completed successfully — NOW clear the saved workspace to prevent
          // double-restore on next launch. This is the key safety improvement: if the
          // app crashed before reaching this point, the data would still be intact.
          await setSetting("saved_workspace", "").catch(console.error);
        } finally {
          workspaceRestoreInProgress = false;
        }
      })
      .catch((err) => {
        workspaceRestoreInProgress = false;
        console.error("[SessionContext] Workspace restore failed:", err);
      });

    getRecentSessions(10)
      .then((entries) => dispatch({ type: "SET_RECENT", entries }))
      .catch(console.error);

    return () => {
      unlisteners.forEach((u) => u());
      closeTimers.current.forEach((t) => clearTimeout(t));
      closeTimers.current.clear();
    };
  }, []);

  const createSession = useCallback(async (opts?: CreateSessionOpts) => {
    // Always pre-generate the session ID so we can set up the terminal
    // output listener BEFORE the PTY starts.  This prevents a race where
    // early output (SSH banner, tmux alternate-screen switch) is lost
    // because no listener exists yet — which garbles tmux rendering.
    const preSessionId = opts?.sessionId || crypto.randomUUID();
    try {

      // Create worktrees for each git project with a branch selection
      const sharedBranches: string[] = [];
      const worktreeErrors: string[] = [];
      if (opts?.branchSelections && opts?.projectIds?.length) {
        for (const projectId of opts.projectIds) {
          const sel = opts.branchSelections[projectId];
          if (!sel) continue; // Non-git project or user skipped branches for this project
          try {
            const wtResult = await createWorktree(preSessionId, projectId, sel.branch, sel.createNew, sel.fromRemote);
            if (wtResult.isShared) {
              sharedBranches.push(sel.branch);
            }
          } catch (wtErr) {
            console.warn(`[SessionContext] Failed to create worktree for project ${projectId}:`, wtErr);
            worktreeErrors.push(`${projectId}: ${wtErr}`);
          }
        }
      } else if (opts?.branchName && opts?.projectIds?.length) {
        // Legacy: single branch for first project (backward compatibility)
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

      // Notify the UI about worktree creation failures so the user knows
      // which projects lack branch isolation.  The session still proceeds.
      if (worktreeErrors.length > 0) {
        window.dispatchEvent(new CustomEvent("hermes:worktree-errors", {
          detail: { errors: worktreeErrors, sessionLabel: opts?.label },
        }));
      }

      // Set up the terminal + output listener BEFORE creating the backend
      // session so no PTY output events are missed.
      // For agent-mode sessions there is no PTY, but we still pre-create the
      // (empty) TerminalPool entry to keep the lifecycle uniform — destroying
      // it later is a no-op if the session was agent-only.
      await createTerminal(preSessionId, opts?.color || "");

      // Estimate terminal dimensions from window size and font settings so the
      // PTY starts at the correct size.  This eliminates the SIGWINCH race where
      // the shell starts at 80x24 and misses the initial resize from attach().
      const initialDims = estimateInitialDimensions();

      // Pick the runtime mode.  If the caller passed an explicit mode, use it;
      // otherwise default to "agent" for Claude and "terminal" for everything
      // else.  Agent mode is Claude-only in 1.0.0 — non-Claude providers are
      // forced back to "terminal" even if the caller requested "agent".
      const mode = resolveSessionMode(opts?.mode, opts?.aiProvider);

      const session = await apiCreateSession({
        sessionId: preSessionId,
        label: opts?.label || null,
        workingDirectory: opts?.workingDirectory || null,
        color: opts?.color || null,
        workspacePaths: null,
        aiProvider: opts?.aiProvider || null,
        projectIds: opts?.projectIds || null,
        autoApprove: opts?.autoApprove ?? false,
        permissionMode: opts?.permissionMode || null,
        customPrefix: opts?.customPrefix || null,
        customSuffix: opts?.customSuffix || null,
        channels: opts?.channels || null,
        sshHost: opts?.sshHost || null,
        sshPort: opts?.sshPort || null,
        sshUser: opts?.sshUser || null,
        tmuxSession: opts?.tmuxSession || null,
        sshIdentityFile: opts?.sshIdentityFile || null,
        initialRows: initialDims.rows,
        initialCols: initialDims.cols,
        mode,
      });

      // Agent mode: the backend `create_session` skipped PTY spawn for us.
      // Bring up the Claude subprocess now so the AgentSessionView has a
      // running agent to talk to.  Errors are reported through the agent
      // event stream rather than failing this call.  We capture the returned
      // Claude UUID into `claudeUuids` so a later model swap can pass it
      // back as `--resume <uuid>` and keep the conversation context.
      if (mode === "agent") {
        // Attach the init-event listener BEFORE spawning so we don't miss
        // the very first init that arrives during boot.
        void attachInitListener(session.id);
        // Snapshot the addDirs we're spawning with BEFORE the IPC fires, so
        // that even if the user attaches another project before the spawn
        // resolves, the drift-detection in submitAgentMessage compares
        // against the right baseline.  Without this baseline, the first
        // user message would see `live=[paths]` vs `prior=[]` and trigger
        // a needless respawn-with-resume against a freshly-spawned UUID
        // the SDK hasn't yet persisted (the visible failure was the
        // "No conversation found with session ID" stderr).
        claudeAddDirs.current.set(session.id, [...session.workspace_paths]);
        spawnAgentSession({
          sessionId: session.id,
          workingDir: session.working_directory,
          addDirs: session.workspace_paths,
        })
          .then((uuid) => { claudeUuids.current.set(session.id, uuid); })
          .catch((err) => {
            console.error("[SessionContext] Failed to spawn Claude agent:", err);
          });
      }

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

      if (opts?.description) {
        updateSessionDescription(session.id, opts.description).catch(console.error);
      }
      if (opts?.group) {
        updateSessionGroup(session.id, opts.group).catch(console.error);
      }
      dispatch({ type: "SESSION_UPDATED", session });
      dispatch({ type: "SET_ACTIVE", id: session.id });
      trackSessionCreated({
        execution_mode: defaultModeRef.current,
        has_ai_provider: !!opts?.aiProvider,
      });

      // Warn about shared worktrees via custom event (App.tsx listens for this)
      if (sharedBranches.length > 0) {
        window.dispatchEvent(new CustomEvent("hermes:shared-worktree", {
          detail: { branches: sharedBranches, sessionLabel: session.label },
        }));
      }

      return session;
    } catch (err) {
      console.error("Failed to create session:", err);
      // Clean up the pre-created terminal if backend session creation failed
      destroyTerminal(preSessionId);
      return null;
    }
  }, []);

  // Keep a ref to the latest state (avoids stale closures in timeouts and saveWorkspace)
  const stateRef = useRef(state);

  const closeSession = useCallback(async (id: string) => {
    if (closingSessionIds.current.has(id)) return; // Prevent double-close race
    closingSessionIds.current.add(id);
    try {
      await apiCloseSession(id);
    } catch (err) {
      console.error("Failed to close session:", err);
    } finally {
      // Always clean up — if the API succeeded the session-removed event
      // handles removal; if it failed we allow retrying. Also force-remove
      // zombie sessions that the backend no longer tracks.
      closingSessionIds.current.delete(id);
      // Give the backend event a moment to arrive, then force-remove only if
      // the session is still in state (avoids double-dispatch with session-removed event).
      // Track the timer so it can be cancelled on unmount
      const timer = setTimeout(() => {
        closeTimers.current.delete(id);
        if (stateRef.current.sessions[id]) {
          dispatch({ type: "SESSION_REMOVED", id });
        }
      }, 500);
      closeTimers.current.set(id, timer);
    }
  }, [dispatch]);

  const defaultModeRef = useRef(state.defaultMode);
  defaultModeRef.current = state.defaultMode;

  const skipCloseConfirmRef = useRef(state.skipCloseConfirm);
  skipCloseConfirmRef.current = state.skipCloseConfirm;

  const requestCloseSession = useCallback(async (id: string) => {
    try {
      // Check for dirty worktrees before proceeding with close flow
      try {
        const projects = await getSessionProjects(id);
        const dirtyChanges: DirtyWorktreeChange[] = [];

        for (const project of projects) {
          try {
            const changes = await worktreeHasChanges(id, project.id);
            if (changes.has_changes) {
              let branchName: string | null = null;
              try {
                const wtInfo = await getSessionWorktreeInfo(id, project.id);
                branchName = wtInfo?.branchName ?? null;
              } catch {
                // Worktree info not available — continue without branch name
              }
              dirtyChanges.push({
                projectId: project.id,
                projectName: project.name,
                branchName,
                files: changes.files,
              });
            }
          } catch {
            // IPC failure for this project — don't block close
          }
        }

        if (dirtyChanges.length > 0) {
          const session = stateRef.current.sessions[id];
          const label = session?.label || id;
          setPendingDirtyClose({ sessionId: id, label, changes: dirtyChanges });
          return;
        }
      } catch {
        // Failed to get projects — proceed with normal close flow
      }

      // No dirty worktrees — proceed with standard close flow
      if (skipCloseConfirmRef.current) {
        closeSession(id);
      } else {
        dispatch({ type: "REQUEST_CLOSE_SESSION", id });
      }
    } catch (error) {
      console.error('[requestCloseSession] Unhandled error:', error);
      // Fall back to direct close if something unexpected happens
      closeSession(id);
    }
  }, [closeSession, dispatch]);

  // ─── Dirty worktree dialog handlers ─────────────────────────────────

  const handleDirtyStashAndClose = useCallback(async () => {
    if (!pendingDirtyClose) return;
    const { sessionId, changes } = pendingDirtyClose;
    const failures: Array<{ projectName: string; error: string }> = [];
    for (const change of changes) {
      try {
        await stashWorktree(sessionId, change.projectId, "Auto-stash before closing session");
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn("[SessionContext] Failed to stash worktree:", e);
        failures.push({ projectName: change.projectName, error: message });
      }
    }
    if (failures.length > 0) {
      // Do NOT close — show errors in the dialog so the user can decide
      setPendingDirtyClose((prev) => prev ? { ...prev, stashErrors: failures } : null);
      return;
    }
    setPendingDirtyClose(null);
    // All stashes succeeded — proceed with close
    if (skipCloseConfirmRef.current) {
      closeSession(sessionId);
    } else {
      dispatch({ type: "REQUEST_CLOSE_SESSION", id: sessionId });
    }
  }, [pendingDirtyClose, closeSession, dispatch]);

  const handleDirtyCloseAnyway = useCallback(() => {
    if (!pendingDirtyClose) return;
    const { sessionId } = pendingDirtyClose;
    setPendingDirtyClose(null);
    // Proceed with close without stashing
    if (skipCloseConfirmRef.current) {
      closeSession(sessionId);
    } else {
      dispatch({ type: "REQUEST_CLOSE_SESSION", id: sessionId });
    }
  }, [pendingDirtyClose, closeSession, dispatch]);

  const handleDirtyCancelClose = useCallback(() => {
    setPendingDirtyClose(null);
  }, []);

  const setActive = useCallback((id: string | null) => {
    dispatch({ type: "SET_ACTIVE", id });
  }, []);

  // stateRef is declared above closeSession
  stateRef.current = state;

  const saveWorkspace = useCallback(async () => {
    // Never save during an active restore — we'd overwrite partial state
    if (workspaceRestoreInProgress) return;

    const current = stateRef.current;
    const liveSessions = Object.values(current.sessions).filter((s) => s.phase !== "destroyed");
    if (liveSessions.length === 0) {
      // Clear stale workspace so closed sessions don't reappear on next launch
      await setSetting("saved_workspace", "").catch(console.error);
      return;
    }

    try {
      // 1. Save scrollback snapshots for all live sessions (without closing them)
      await saveAllSnapshots();

      // 2. Collect session metadata + project IDs
      const sessionInfos: SavedSessionInfo[] = await Promise.all(
        liveSessions.map(async (s) => {
          let projectIds: string[] = [];
          try {
            const projects = await getSessionProjects(s.id);
            projectIds = projects.map((p) => p.id);
          } catch { /* ignore — projects are optional */ }
          // Capture per-session agent state from the in-memory refs so a
          // restart can `--resume <claude-session-uuid>` and respawn with
          // the same model/perm/effort/add-dirs the user last had active.
          const claudeUuid = claudeUuids.current.get(s.id);
          const agentModel = claudeModels.current.get(s.id);
          const agentPerm = claudePermissionModes.current.get(s.id);
          const agentEffort = claudeEfforts.current.get(s.id);
          return {
            id: s.id,
            label: s.label,
            description: s.description,
            color: s.color,
            group: s.group,
            working_directory: s.working_directory,
            ai_provider: s.ai_provider,
            auto_approve: s.auto_approve ?? false,
            permission_mode: s.permission_mode ?? "default",
            custom_prefix: s.custom_prefix ?? "",
            custom_suffix: s.custom_suffix ?? "",
            project_ids: projectIds,
            ssh_info: s.ssh_info || null,
            mode: s.mode ?? "terminal",
            // Only include agent fields when actually populated — keeps the
            // saved JSON small and avoids stamping stale defaults on
            // terminal-mode sessions.
            ...(claudeUuid ? { claude_session_uuid: claudeUuid } : {}),
            ...(agentModel ? { agent_model: agentModel } : {}),
            ...(agentPerm ? { agent_permission_mode: agentPerm } : {}),
            ...(agentEffort ? { agent_effort: agentEffort } : {}),
            ...(s.workspace_paths.length > 0 ? { agent_add_dirs: s.workspace_paths } : {}),
          };
        }),
      );

      // 3. Serialize workspace state with version stamp
      const workspace: SavedWorkspace = {
        version: SAVED_WORKSPACE_VERSION,
        sessions: sessionInfos,
        layout: current.layout.root,
        focused_pane_id: current.layout.focusedPaneId,
        active_session_id: current.activeSessionId,
      };

      await setSetting("saved_workspace", JSON.stringify(workspace));
    } catch (err) {
      console.error("[SessionContext] Failed to save workspace:", err);
    }
  }, []);

  // ─── Mode conversion (right-click "Convert to ...") ─────────────────
  // Tears down the existing subprocess for the current mode, flips the
  // session's `mode` field in state, and spawns a fresh subprocess for the
  // new mode.  The conversation/scrollback of the previous mode is dropped.
  const convertSessionMode = useCallback(async (sessionId: string, newMode: SessionMode): Promise<boolean> => {
    const session = stateRef.current.sessions[sessionId];
    if (!session) return false;
    if (session.mode === newMode) return true;

    // Agent mode is Claude-only in 1.0.0.
    if (newMode === "agent" && session.ai_provider !== "claude") {
      console.warn("[SessionContext] Refusing to convert non-Claude session to agent mode");
      return false;
    }

    try {
      // 1. Close whatever process is currently running for this session.
      if (session.mode === "agent") {
        await closeAgentSession(sessionId).catch((err) => {
          console.warn("[SessionContext] Failed to close agent during conversion:", err);
        });
      } else {
        // Terminal/PTY: ask the backend to tear down the PTY but keep the
        // session row (so we can re-spawn into it).  The dedicated
        // `close_session` command also fires `session-removed`, which would
        // wipe the session from state — that's the wrong behaviour here.
        // For 1.0.0 we accept the simplification of losing scrollback and
        // re-issue close_session; the SET_SESSION_MODE dispatch below
        // immediately re-establishes state for the new mode.
        await apiCloseSession(sessionId).catch((err) => {
          console.warn("[SessionContext] Failed to close terminal during conversion:", err);
        });
      }

      // 2. Flip the mode in state so SplitPane re-renders the right view.
      dispatch({ type: "SET_SESSION_MODE", sessionId, mode: newMode });

      // 3. Spawn the new-mode subprocess.
      if (newMode === "agent") {
        void attachInitListener(sessionId);
        claudeAddDirs.current.set(sessionId, [...session.workspace_paths]);
        await spawnAgentSession({
          sessionId,
          workingDir: session.working_directory,
          addDirs: session.workspace_paths,
        });
      } else {
        // Terminal mode: re-issue `create_session` against the backend with
        // the same id.  The backend treats it as a fresh PTY spawn.
        await apiCreateSession({
          sessionId,
          label: session.label,
          workingDirectory: session.working_directory,
          color: session.color,
          workspacePaths: session.workspace_paths.length > 0 ? session.workspace_paths : null,
          aiProvider: session.ai_provider,
          projectIds: null,
          autoApprove: session.auto_approve,
          permissionMode: session.permission_mode,
          customPrefix: session.custom_prefix,
          customSuffix: session.custom_suffix,
          channels: session.channels.length > 0 ? session.channels : null,
          sshHost: session.ssh_info?.host || null,
          sshPort: session.ssh_info?.port || null,
          sshUser: session.ssh_info?.user || null,
          tmuxSession: session.ssh_info?.tmux_session || null,
          sshIdentityFile: session.ssh_info?.identity_file || null,
          mode: "terminal",
        });
      }
      return true;
    } catch (err) {
      console.error("[SessionContext] convertSessionMode failed:", err);
      return false;
    }
  }, [dispatch]);

  /** Internal: tear down the current Claude subprocess and respawn it.
   *
   *  Two respawn modes — picked automatically based on whether any flags are
   *  changing on this call:
   *
   *    - **Plain resume** (no flag overrides): `--resume <prior-uuid>`.
   *      Claude reloads the session and keeps its existing model + perm.
   *      Used by `submitAgentMessage` to continue a conversation between
   *      turns (Claude's `--print` subprocess exits after every result).
   *    - **Fork** (overrides given): `--session-id <new> --resume <prior>
   *      --fork-session` plus the new `--model` / `--permission-mode`.
   *      Claude branches a fresh session id from the prior history and
   *      applies the new flags — this is the only flag combination in
   *      which model/permission swaps actually take effect mid-conversation.
   *
   *  The `claudeUuids` map is updated to whichever id Claude returned
   *  (same id on plain resume, new id on fork) so subsequent respawns
   *  continue from the latest active session. */
  const respawnAgent = useCallback(async (
    sessionId: string,
    overrides: {
      model?: string | null;
      permissionMode?: string | null;
      effort?: string | null;
    },
  ): Promise<boolean> => {
    const session = stateRef.current.sessions[sessionId];
    if (!session) return false;
    if (session.mode !== "agent") {
      console.warn("[SessionContext] respawnAgent: session is not agent-mode");
      return false;
    }

    // Resolve effective flags by layering overrides on the last-known values.
    const currentModel = claudeModels.current.get(sessionId);
    const currentMode = claudePermissionModes.current.get(sessionId);
    const currentEffort = claudeEfforts.current.get(sessionId);
    const nextModelInput =
      overrides.model !== undefined ? overrides.model : currentModel ?? null;
    const nextModeInput =
      overrides.permissionMode !== undefined
        ? overrides.permissionMode
        : currentMode ?? null;
    const nextEffortInput =
      overrides.effort !== undefined ? overrides.effort : currentEffort ?? null;

    const nextModel =
      nextModelInput && nextModelInput.toLowerCase() !== "default"
        ? nextModelInput
        : undefined;
    const nextMode = nextModeInput ?? undefined;
    const nextEffort = nextEffortInput ?? undefined;

    const priorUuid = claudeUuids.current.get(sessionId);
    const isFlagChange =
      overrides.model !== undefined ||
      overrides.permissionMode !== undefined ||
      overrides.effort !== undefined;
    const fork = isFlagChange && priorUuid !== undefined;

    // Verbose debug logging — guarded by a global flag so we can flip it
    // off later, but on by default during the model-swap stabilization
    // window so production failures leave a paper trail in DevTools.
    // Search the console for `[respawn]` to find every spawn we attempted.
    // Plain-string log so DevTools shows the values without `Object` collapse.
    console.log(
      `[respawn] sid=${sessionId} prior=${priorUuid ?? "<none>"} fork=${fork}` +
      ` overrides=${JSON.stringify(overrides)}` +
      ` effective={model:${nextModel ?? "<none>"}, perm:${nextMode ?? "<none>"}, effort:${nextEffort ?? "<none>"}}` +
      ` addDirs=${JSON.stringify(session.workspace_paths)}`,
    );

    try {
      void attachInitListener(sessionId);

      await closeAgentSession(sessionId).catch((err) => {
        console.warn("[SessionContext] closeAgentSession during respawn:", err);
      });

      const newUuid = await spawnAgentSession({
        sessionId,
        workingDir: session.working_directory,
        priorUuid,
        model: nextModel,
        permissionMode: nextMode,
        effort: nextEffort,
        addDirs: session.workspace_paths,
        fork,
      });
      console.log("[respawn] spawn returned uuid:", newUuid, "(prior was:", priorUuid ?? "<none>", ")");
      claudeUuids.current.set(sessionId, newUuid);
      claudeModels.current.set(sessionId, nextModel);
      claudePermissionModes.current.set(sessionId, nextMode);
      claudeEfforts.current.set(sessionId, nextEffort);
      // Snapshot the addDirs we just spawned with so submitAgentMessage
      // can detect drift (user attached/detached a project) on the next turn.
      claudeAddDirs.current.set(sessionId, [...session.workspace_paths]);
      return true;
    } catch (err) {
      console.error("[SessionContext] respawnAgent failed:", err);
      return false;
    }
  }, [attachInitListener]);

  // Switch the active model on a live agent-mode session.  Claude's
  // stream-json subprocess takes the model as a spawn-time flag, and the
  // fork respawn that picks the new model only persists if there's user
  // input to feed it.  So we *queue* the change here and let
  // `submitAgentMessage` perform the fork on the next user submit.
  // The chip's `pending` indicator stays lit between click and submit.
  const switchAgentModel = useCallback(async (
    sessionId: string,
    model: string | null,
  ): Promise<boolean> => {
    queuePendingFlag(sessionId, { model });
    return true;
  }, [queuePendingFlag]);

  /** Queue a permission-mode change.  Same deferred-fork pattern as
   *  `switchAgentModel`. */
  const switchAgentPermissionMode = useCallback(async (
    sessionId: string,
    permissionMode: string | null,
  ): Promise<boolean> => {
    queuePendingFlag(sessionId, { permissionMode });
    return true;
  }, [queuePendingFlag]);

  /** Queue an effort change.  Same deferred-fork pattern as
   *  `switchAgentModel`. */
  const switchAgentEffort = useCallback(async (
    sessionId: string,
    effort: string | null,
  ): Promise<boolean> => {
    queuePendingFlag(sessionId, { effort });
    return true;
  }, [queuePendingFlag]);

  /**
   * Send a user message to a Claude agent session, auto-respawning the
   * subprocess if it has exited between turns.
   *
   * Claude's `claude --print --output-format stream-json --input-format stream-json`
   * is one-shot per spawn — after each turn the subprocess emits its
   * `result` event and exits.  To keep a multi-turn conversation alive we
   * have to spawn a fresh child for every user message, passing
   * `--resume <claude-session-uuid>` so the same conversation thread is
   * loaded.  This function papers over that lifecycle: callers just submit;
   * we transparently bring the subprocess back if it's gone.
   *
   * On retry we reuse the same `UserEnvelope` (same `uuid`) so the message
   * is only echoed into the rendered conversation once — no duplicate row.
   */
  const submitAgentMessage = useCallback(async (
    sessionId: string,
    draft: string,
    attachments: AgentAttachment[],
  ): Promise<void> => {
    const envelope = buildUserEnvelope(draft, attachments);
    if (!envelope) return;

    // Echo first so the user sees their own message immediately even if
    // we're about to respawn the subprocess.
    await echoUserEnvelope(sessionId, envelope);

    // Apply any queued flag changes (model / permission mode / effort)
    // BEFORE the send.  This is the production-bug fix: forking with no
    // user input on stdin makes Claude exit without persisting, so we
    // wait until there's a real message to feed the new subprocess.
    const queued = pendingFlags.current.get(sessionId);
    let mustRespawn = !!queued && (
      queued.model !== undefined
      || queued.permissionMode !== undefined
      || queued.effort !== undefined
    );

    // Detect attach/detach drift: if the live session has different
    // workspace_paths than what the bridge was spawned with, respawn so
    // Claude's file-tools (Read/Edit) can access the new paths.  The MCP
    // tool already exposes the path list to Claude (M5) but file IO
    // needs a fresh `--add-dir`, which is a spawn-time flag.
    const session = stateRef.current.sessions[sessionId];
    if (session?.mode === "agent") {
      const live = session.workspace_paths;
      const prior = claudeAddDirs.current.get(sessionId) ?? [];
      const drift = hasAddDirDrift(prior, live);
      console.log(
        `[addDirs] sid=${sessionId} live=${JSON.stringify(live)}` +
        ` prior=${JSON.stringify(prior)} drift=${drift}`,
      );
      if (drift) {
        mustRespawn = true;
      }
    }

    if (mustRespawn) {
      const ok = await respawnAgent(sessionId, queued ?? {});
      if (ok && queued) pendingFlags.current.delete(sessionId);
    }

    try {
      await sendUserEnvelope(sessionId, envelope);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Rust returns `"Agent session '<id>' not found"` when the entry has
      // been removed from the sessions map (either via close or because the
      // subprocess exited and the waiter cleared it).
      if (!message.toLowerCase().includes("not found")) throw err;

      const ok = await respawnAgent(sessionId, {});
      if (!ok) throw new Error("Could not revive Claude subprocess");
      await sendUserEnvelope(sessionId, envelope);
    }
  }, [respawnAgent]);

  /** Send an arbitrary envelope (tool_result, _hermes_perm_response,
   *  etc.) with automatic respawn-on-not-found.  Used by the
   *  interactive cards (AskUserQuestion, ExitPlanMode, canUseTool).
   *  See `src/utils/sendAgentEnvelope.ts` for the retry contract. */
  const sendAgentEnvelope = useCallback(async (
    sessionId: string,
    envelope: unknown,
  ): Promise<void> => {
    await sendAgentEnvelopeWithRevive(sessionId, envelope, {
      // Direct IPC — Rust accepts any JSON value, looser-typed than
      // sendUserEnvelope which insists on the UserEnvelope shape.
      send: (sid, env) => sendAgentInput(sid, env),
      respawn: async (sid) => respawnAgent(sid, {}),
    });
  }, [respawnAgent]);

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

  // ─── Hermes IDE state → bridge sync ──────────────────────────────
  //
  // Whenever an agent session's `workspace_paths` changes (or `phase` ticks
  // through `idle` etc.), push a fresh state file to the bridge so its MCP
  // tools reflect reality.  Cheap — Rust just rewrites a small JSON file.
  // We deliberately key on a flat hash of the relevant fields rather than
  // the whole `state.sessions` map so unrelated edits don't trigger a
  // round-trip.
  const lastIdeStateHash = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const s of Object.values(state.sessions)) {
      if (s.mode !== "agent") continue;
      const payload = {
        cwd: s.working_directory,
        attachedPaths: s.workspace_paths,
        // memory + pinnedFiles will be wired in M5 when the always-on
        // Context Panel exposes them; for now they default to [].
        memory: [],
        pinnedFiles: [],
      };
      const hash = JSON.stringify(payload);
      if (lastIdeStateHash.current.get(s.id) === hash) continue;
      lastIdeStateHash.current.set(s.id, hash);
      updateHermesState(s.id, payload).catch((err) => {
        console.warn("[SessionContext] updateHermesState failed:", err);
      });
    }
  }, [state.sessions]);

  // Periodic frontend auto-save — captures layout, focused pane, and active session
  // alongside the session metadata that the Rust auto-save also persists.
  const saveWorkspaceRef = useRef(saveWorkspace);
  saveWorkspaceRef.current = saveWorkspace;
  useEffect(() => {
    const interval = setInterval(() => {
      if (!workspaceDirty) return;
      workspaceDirty = false;
      saveWorkspaceRef.current().catch(console.error);
    }, 10_000); // every 10 seconds
    return () => clearInterval(interval);
  }, []);

  return (
    <SessionContext.Provider value={{ state, dispatch, createSession, closeSession, requestCloseSession, setActive, saveWorkspace, convertSessionMode, switchAgentModel, switchAgentPermissionMode, switchAgentEffort, submitAgentMessage, sendAgentEnvelope, respawnAgent: (sessionId) => respawnAgent(sessionId, {}) }}>
      {children}
      {pendingDirtyClose && (
        <DirtyWorktreeDialog
          sessionId={pendingDirtyClose.sessionId}
          sessionLabel={pendingDirtyClose.label}
          changes={pendingDirtyClose.changes}
          stashErrors={pendingDirtyClose.stashErrors}
          onStashAndClose={handleDirtyStashAndClose}
          onCloseAnyway={handleDirtyCloseAnyway}
          onCancel={handleDirtyCancelClose}
        />
      )}
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

/**
 * Orders sessions to match the sidebar visual order:
 * named groups (alphabetically) → ungrouped, with destroyed sessions last within each group.
 */
export function sidebarOrderSessions(sessions: SessionData[]): SessionData[] {
  const grouped = new Map<string | null, SessionData[]>();
  for (const session of sessions) {
    const group = session.group || null;
    const list = grouped.get(group) || [];
    list.push(session);
    grouped.set(group, list);
  }
  // Sort within each group: destroyed sessions last
  const sortGroup = (list: SessionData[]) =>
    [...list].sort((a, b) => {
      const aD = a.phase === "destroyed" ? 1 : 0;
      const bD = b.phase === "destroyed" ? 1 : 0;
      return aD - bD;
    });
  // Named groups alphabetically, then ungrouped
  const namedKeys = Array.from(grouped.keys())
    .filter((g): g is string => g !== null)
    .sort();
  const result: SessionData[] = [];
  for (const key of namedKeys) {
    result.push(...sortGroup(grouped.get(key)!));
  }
  const ungrouped = grouped.get(null);
  if (ungrouped) {
    result.push(...sortGroup(ungrouped));
  }
  return result;
}

/** Hook wrapper around sidebarOrderSessions. */
export function useSidebarOrderedSessions(): SessionData[] {
  const sessions = useSessionList();
  return useMemo(() => sidebarOrderSessions(sessions), [sessions]);
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

/**
 * Read this session's composer draft + height + expanded flag. Returns
 * sensible defaults (empty draft, 120px height, collapsed) when the session
 * has no entry yet, so callers don't need to dispatch on mount.
 *
 * `expanded` defaults to `false` — the composer renders as a small chat
 * icon in the corner of the agent pane until the user opens it.
 */
export function useComposer(sessionId: string): { draft: string; height: number; expanded: boolean } {
  const { state } = useSession();
  const entry = state.composers[sessionId];
  if (entry) return entry;
  // Default-open for agent sessions (the composer IS the input surface) and
  // default-collapsed for terminal sessions (where the composer is a side dock).
  const session = state.sessions[sessionId];
  const expandedDefault = session?.mode === "agent";
  return { draft: "", height: 120, expanded: expandedDefault };
}

export function useAutonomousSettings() {
  const { state } = useSession();
  return state.autonomousSettings;
}
