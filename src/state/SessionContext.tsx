import { useContext, useReducer, useEffect, useCallback, useMemo, useRef, useState, Suspense, ReactNode } from "react";
import { SessionContextObject } from "./sessionContextObject";
import { lazyView } from "../utils/lazyView";
import { markStartupSession } from "../attention/startupSessions";
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
// Set once the launch's restore has settled. Before that the session list is
// not loaded yet, so a save would write an empty or partial workspace over
// the one about to be restored.
let workspaceLoaded = false;
// Set when this launch restored no session from a saved workspace (restore
// turned off, every session failed to start, unreadable data). Until a
// session exists, a save leaves that saved workspace alone instead of
// writing an empty one over it.
let keepSavedWorkspace = false;
// Saves run one after another, so an older snapshot of the state can never
// land after a newer one.
let saveChain: Promise<void> = Promise.resolve();
import {
  createSession as apiCreateSession, closeSession as apiCloseSession,
  getSessions, getRecentSessions, getSessionSnapshot,
  updateSessionDescription, updateSessionGroup, updateSessionLabel,
  saveAllSnapshots,
  addWorkspacePath,
  sessionHostStatus,
} from "../api/sessions";
import { deriveSessionLabelFromMessage, isDefaultSessionLabel } from "../utils/autoSessionLabel";
import { getProjects, getSessionProjects, attachSessionProject } from "../api/projects";
import { autoAttachInsideProject } from "../utils/autoAttach";
import { hasAddDirDrift } from "../utils/agentDrift";
import {
  createWorktree, worktreeHasChanges, stashWorktree, getSessionWorktreeInfo,
  attachWorktree, detachWorktree, removeWorktree,
  gitListBranchesForProject, keepWorktree, commitKeptWorktree, saveKeptDetachedHead, removeLeftoverWorktree,
} from "../api/git";
import { parseHookRefusal, plainGitError } from "../utils/gitErrors";
import { isFeatureFlagEnabled } from "../featureFlags";
import {
  createSessionWorktrees, pickRestoreId, closeCommitMessage, shouldAskAboutChangesOnClose, describeBranchHolder,
  withUnrestoredSessions,
  type BranchConflictChoice, type BranchInUse, type ReusedCheckout,
} from "./isolation";
import { useSaveWorkspaceOnChange } from "./useSaveWorkspaceOnChange";
import { nestUnderParents } from "../limits/handoff";
import { useWorkspaceFlushOnQuit } from "./useWorkspaceFlushOnQuit";
import { runWorktreeRecipes, type CreatedWorktree } from "./worktreeRecipes";
// Shown only when a branch is in use elsewhere: its code loads on demand.
const BranchConflictDialog = lazyView("BranchConflictDialog", () => import("../components/BranchConflictDialog").then((m) => m.BranchConflictDialog));
import type { SessionWorktree, WorktreeChanges } from "../types/git";
import { getSettings, getSetting, setSetting } from "../api/settings";
import { createTerminal, destroy as destroyTerminal, writeScrollback, releaseOutput, estimateInitialDimensions } from "../terminal/TerminalPool";
import { applyTheme, applyAgentTimelineStyle } from "../utils/themeManager";
import { restoreWindowState } from "../utils/windowState";
import { initNotifications, notifyLongRunningDone } from "../utils/notifications";
import { initAnalytics, trackAppStarted, trackSessionCreated } from "../utils/analytics";
import {
  LayoutNode, PaneLeaf,
  nextPaneId, nextSplitId,
  replaceNode, removePane, collectPanes, updateSplitRatio,
  setPaneSession, removePanesBySession,
} from "./layoutTypes";
import { tileLayout } from "./tileLayout";
import type { DirtyWorktreeChange } from "../components/DirtyWorktreeDialog";
// Shown only when a closing session has work left: its code loads on demand.
const DirtyWorktreeDialog = lazyView("DirtyWorktreeDialog", () => import("../components/DirtyWorktreeDialog").then((m) => m.DirtyWorktreeDialog));

// ─── Re-export shared types for backward compatibility ──────────────
export type {
  ActionEvent, ActionTemplate, SessionData, SessionHistoryEntry,
  CreateSessionOpts, SessionAction, SessionMode,
} from "../types/session";

import type {
  SessionData, SessionHistoryEntry, CreateSessionOpts, SessionAction,
  SavedWorkspace, SavedSessionInfo, SessionMode,
} from "../types/session";
import { SAVED_WORKSPACE_VERSION, validateSavedWorkspace } from "../types/session";
import { hasAgentView } from "../utils/sessionModePref";
import {
  clampWorkbenchRatio,
  clampFilesNotesSplit,
  clampNoteContent,
  loadWorkbenchLayout,
  serializeWorkbenchLayout,
  loadNotesMap,
  serializeNotesMap,
} from "../utils/workbenchLayout";
import { spawnAgentSession, restartAgentSession, closeAgentSession, sendAgentInput, updateHermesState, setAgentPermissionMode, getAgentHistory } from "../api/agent";
import { reportAgentSpawnFailure } from "../utils/agentSpawnFailure";
import { createRespawnQueue, respawnJoinDisabledForTest } from "../utils/respawnQueue";
import { destroyAgentSessionStore, getOrCreateAgentSessionStore } from "../agent/agentSessionStore";
import { cleanupSessionRefs } from "../utils/sessionRefCleanup";
import { cacheAgentInit, clearAgentInitCache, peekAgentInitCache } from "../agent/useAgentInit";
import { clearSessionEvents } from "../agent/contract/sessionEventStore";
import {
  buildUserEnvelope,
  echoUserEnvelope,
  sendUserEnvelope,
  type AgentAttachment,
} from "../utils/submitToAgent";
import { sendAgentEnvelopeWithRevive } from "../utils/sendAgentEnvelope";
import { setE2ESessionBridge } from "../e2e/sessionBridge";

// ─── Mode-conversion worktree-preservation helper ────────────────────

/**
 * Decide whether a session-mode conversion needs to restore worktrees
 * after teardown but before respawn.
 *
 * Bug 4 (1.2.x):
 *   - Terminal close runs `apiCloseSession`, which (after Bug 1's fix)
 *     unconditionally cleans worktrees from disk + DB.  If the next
 *     step is to spawn an agent in the OLD `session.working_directory`,
 *     that directory no longer exists and the subprocess fails to boot.
 *   - Agent close runs `closeAgentSession`, which only kills the
 *     bridge subprocess and leaves `session_worktrees` rows alone.
 *     The subsequent `apiCreateSession` finds the row and resolves cwd
 *     correctly — no restore is needed.
 *
 * Exported so the decision can be unit-tested without a React tree.
 */
export type ConversionWorktreePlan = "restore-before-spawn" | "no-op";

export function planConversionWorktreeRestore(args: {
  currentMode: SessionMode;
  newMode: SessionMode;
}): ConversionWorktreePlan {
  if (args.currentMode === args.newMode) return "no-op";
  // Only the terminal → agent direction loses the worktree to
  // apiCloseSession's cleanup.
  if (args.currentMode === "terminal" && args.newMode === "agent") {
    return "restore-before-spawn";
  }
  return "no-op";
}

/**
 * Snapshot of an isolated worktree the session owns, captured BEFORE a
 * mode-conversion teardown so it can be re-created afterwards.
 *
 * Main worktrees (project root) and worktrees with no branch info are
 * skipped — they don't need re-creation.
 */
export interface PreservedWorktreeEntry {
  projectId: string;
  branchName: string;
}

/**
 * Capture every isolated worktree row linked to `sessionId` so the caller
 * can re-create them after `apiCloseSession` wipes the disk + DB state.
 *
 * Non-throwing: a transient DB / IPC error here must NOT prevent the
 * conversion from proceeding — at worst the session re-spawns without
 * isolation (the pre-fix behaviour, which is itself surfaced by
 * Bug 3's defence-in-depth).  We return whatever we managed to collect.
 *
 * See Bug 4 in `docs/internal/agent-mode-bug-1-2-x-regressions.md`.
 */
export async function snapshotPreservableWorktrees(
  sessionId: string,
): Promise<PreservedWorktreeEntry[]> {
  let projects: Array<{ id: string }> = [];
  try {
    projects = await getSessionProjects(sessionId);
  } catch (err) {
    console.warn("[SessionContext] snapshotPreservableWorktrees: getSessionProjects failed:", err);
    return [];
  }

  const preserved: PreservedWorktreeEntry[] = [];
  for (const project of projects) {
    let wt: SessionWorktree | null = null;
    try {
      wt = await getSessionWorktreeInfo(sessionId, project.id);
    } catch (err) {
      console.warn(
        `[SessionContext] snapshotPreservableWorktrees: getSessionWorktreeInfo failed for project ${project.id}:`,
        err,
      );
      continue;
    }
    if (!wt) continue;
    if (wt.isMainWorktree) continue; // Main worktrees don't need re-creation
    if (!wt.branchName) continue;     // Can't re-create without a branch
    preserved.push({ projectId: wt.projectId, branchName: wt.branchName });
  }
  return preserved;
}

/**
 * Re-create the worktrees captured by `snapshotPreservableWorktrees`,
 * after `apiCloseSession` has run.  Individual failures are logged but
 * not propagated — restoring 2/3 worktrees is strictly better than
 * aborting the whole conversion because of one transient error.
 *
 * Called between the close step and the spawn step in
 * `convertSessionMode` so the new subprocess sees a populated
 * `session_worktrees` table and an existing worktree directory.
 */
export async function restorePreservedWorktrees(
  sessionId: string,
  preserved: PreservedWorktreeEntry[],
): Promise<void> {
  for (const wt of preserved) {
    try {
      await createWorktree(sessionId, wt.projectId, wt.branchName, false);
    } catch (err) {
      console.warn(
        `[SessionContext] restorePreservedWorktrees: createWorktree failed for project ${wt.projectId} (branch ${wt.branchName}):`,
        err,
      );
    }
  }
}

// ─── Worktree-failure escalation helper ─────────────────────────────

/**
 * Decide whether a session creation MUST abort because every requested
 * worktree failed to be created.
 *
 * Bug 3 (1.2.x): when the user picked branches but every `createWorktree`
 * threw, `createSession` previously caught each error and proceeded to
 * call `apiCreateSession` anyway.  The backend then resolved cwd to the
 * project root (no session_worktrees row was inserted), and the agent
 * session booted on the current branch with no isolation — exactly the
 * symptom the user reported as "the branch I selected is not selected,
 * keeps the old one, no worktrees".
 *
 * Decision rule: fatal iff there was at least one error AND zero
 * successes.  Partial successes proceed (the surviving projects get
 * isolation; the rest are surfaced via the `hermes:worktree-errors`
 * event).  Zero errors + zero successes is the legacy "no branch
 * selection" path and must NOT abort.
 *
 * Exported so the decision is unit-testable without rendering the
 * SessionProvider.
 */
export function worktreeFailureIsFatal(args: {
  succeeded: number;
  errorCount: number;
}): boolean {
  return args.errorCount > 0 && args.succeeded === 0;
}

/** id → name of the given projects (empty when they cannot be read). */
async function projectNamesById(ids: readonly string[]): Promise<Record<string, string>> {
  try {
    const all = await getProjects();
    const out: Record<string, string> = {};
    for (const p of all) if (ids.includes(p.id)) out[p.id] = p.name;
    return out;
  } catch {
    return {};
  }
}

// ─── Sessions that end on their own ─────────────────────────────────

/** Sessions that end within this window of each other ended together. */
export const ENDED_BURST_MS = 1200;

/**
 * What to do with sessions whose terminal ended without Hermes closing
 * them. One program that ended while the terminal service runs (`exit` in
 * the shell) closes as it always did. Several at once, or with the terminal
 * service gone, is a crash: the rows stay, ended, with their output and a
 * way to restart them — and their worktrees are not deleted behind the
 * person's back.
 */
export function endedSessionsVerdict(args: { count: number; hostGone: boolean }): "close" | "keep" {
  return args.hostGone || args.count > 1 ? "keep" : "close";
}

// ─── Close: what to ask about a session's worktree ──────────────────

/** A commit hook that refused while closing, for the dialog. */
export interface PendingHookRefusal {
  projectName: string;
  hook: string;
  output: string;
}

/**
 * The close dialog's entry for one project, or null when closing can go
 * ahead without asking: uncommitted files, commits on a detached HEAD that
 * no branch has, an operation in progress, edits inside a submodule, the
 * branch HEAD is really on — and, when the check itself fails, an entry
 * that says so (closing never deletes a worktree it could not check).
 */
export async function closeCheckEntry(
  sessionId: string,
  project: { id: string; name: string },
  recordedBranch: string | null,
  check: (sessionId: string, projectId: string) => Promise<WorktreeChanges>,
): Promise<DirtyWorktreeChange | null> {
  try {
    const changes = await check(sessionId, project.id);
    const head = changes.head ?? null;
    const entry: DirtyWorktreeChange = {
      projectId: project.id,
      projectName: project.name,
      branchName: recordedBranch,
      files: changes.files,
      actualBranch: head ? head.branch : null,
      detached: head?.detached ?? false,
      lostCommits: head?.lostCommits ?? 0,
      operation: head?.operation ?? null,
      dirtySubmodules: head?.dirtySubmodules ?? [],
    };
    const ask = entry.files.length > 0 || (entry.lostCommits ?? 0) > 0 || !!entry.operation || (entry.dirtySubmodules?.length ?? 0) > 0;
    return ask ? entry : null;
  } catch (e) {
    return {
      projectId: project.id,
      projectName: project.name,
      branchName: recordedBranch,
      files: [],
      checkError: plainGitError(e) || "unknown error",
    };
  }
}

// ─── Agent-aware close helper ────────────────────────────────────────

/**
 * Tear down a session's subprocess(es) + backend state in the order that
 * is safe for each mode.
 *
 * Agent-mode sessions run as a Node bridge subprocess registered with
 * `AgentState` on the Rust side; that subprocess is NOT tracked in the
 * PTY manager and therefore is invisible to the Tauri `close_session`
 * command. Closing only via `close_session` would leak the subprocess
 * (zombie) and — until the backend `close_session` is extended to run
 * unconditional worktree cleanup — also leak worktree state.
 *
 * For agent-mode sessions we therefore:
 *   1. Call `close_agent_session` first so the bridge gets EOF, exits
 *      gracefully (or is killed after 1s), and is removed from
 *      `AgentState`. Errors here are non-fatal: "session not found"
 *      means the subprocess already exited.
 *   2. Call `close_session` second so the backend can clean up
 *      worktrees, DB rows, pins, and emit `session-removed`.
 *
 * Terminal-mode sessions only need `close_session`; the PTY child is
 * tracked in the PTY manager and killed inside that command.
 *
 * Exported separately from `closeSession` so the ordering can be
 * exercised in tests without rendering the SessionProvider.
 */
export async function performAgentAwareClose(
  sessionId: string,
  mode: SessionMode,
): Promise<void> {
  if (mode === "agent") {
    await closeAgentSession(sessionId).catch((err) => {
      // The bridge may already have exited (crash, manual kill, etc.).
      // We still need to call apiCloseSession so the backend cleans up
      // worktrees and DB rows — don't propagate.
      console.warn("[SessionContext] closeAgentSession failed (continuing):", err);
    });
  }
  await apiCloseSession(sessionId);
}

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
 * Terminal first (ADR 003): every session runs in terminal mode unless the
 * caller explicitly asked for the Agent view AND the provider has one.
 * There is no provider-specific default any more — Claude included.
 *
 * Exported for testability.
 */
export function resolveSessionMode(
  requested: SessionMode | undefined,
  aiProvider: string | null | undefined,
): SessionMode {
  return requested === "agent" && hasAgentView(aiProvider) ? "agent" : "terminal";
}

// ─── State ──────────────────────────────────────────────────────────

interface SessionState {
  sessions: Record<string, SessionData>;
  activeSessionId: string | null;
  recentSessions: SessionHistoryEntry[];
  autoApplyEnabled: boolean;
  injectionLocks: Record<string, boolean>;
  composers: Record<string, { draft: string; height: number; expanded: boolean }>;
  /** Per-session free-form notes (1.1.14, agent-mode workbench). */
  notes: Record<string, string>;
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
    /** Track panel (F28, flag `featureTracks`) — the Feature Track of the
     *  active session's worktree. Mutex with Context and Usage. */
    trackPanelOpen: boolean;
    sessionListCollapsed: boolean;
    commandPaletteOpen: boolean;
    flowMode: boolean;
    processPanelOpen: boolean;
    gitPanelOpen: boolean;
    fileExplorerOpen: boolean;
    searchPanelOpen: boolean;
    composerOpen: boolean;
    activeLeftTab: "sessions" | "terminal" | "processes" | "git" | "files" | "search";
    filePreview: { projectId: string; filePath: string } | null;
    /** Right-rail Workbench layout — open/tab/ratio/files-notes split.
     *  Agent-mode sessions only; ignored otherwise.  Defaults come from
     *  `DEFAULT_PERSISTED_WORKBENCH` in `utils/workbenchLayout.ts`. */
    workbench: {
      open: boolean;
      tab: "files" | "context" | "git";
      ratio: number;
      filesNotesSplit: number;
    };
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
        // permission_mode drives the live agent's auto-allow behavior
        // (see `InteractivePermissionDispatcher`'s bypass effect in
        // AgentSessionView).  When a user flips the chip mid-session
        // we dispatch SESSION_UPDATED with only this field changed, so
        // it MUST be part of the dedup check or the update is silently
        // dropped and the auto-allow effect never re-fires.
        && existing.permission_mode === action.session.permission_mode
        // The conversation id is what a restore resumes, and the startup
        // state is what the session list shows while an agent starts.
        && (existing.vendor_session_id ?? null) === (action.session.vendor_session_id ?? null)
        && (existing.agent_startup?.state ?? null) === (action.session.agent_startup?.state ?? null)
        && existing.detected_agent?.name === action.session.detected_agent?.name
        && existing.detected_agent?.model === action.session.detected_agent?.model
        && existing.metrics.output_lines === action.session.metrics.output_lines
        && existing.metrics.tool_calls.length === action.session.metrics.tool_calls.length
        // Also check the last tool_call's identity — backend sometimes
        // mutates the most-recent entry in place (compaction, coalescing,
        // canonicalization) without changing the array length.  Without
        // this comparison the reducer drops the update and AgentToolBlock
        // keeps rendering a stale tool name/args.  We only inspect the
        // tail because that's the only realistic mutation pattern (the
        // backend never rewrites historical entries) and we want the
        // dedup check to stay O(1).
        //
        // PERF: compare by REFERENCE equality only.  An earlier draft
        // used JSON.stringify(args) but that runs on every backend
        // session-update tick — and tool args can carry kilobytes of
        // payload (Bash stdout, Read content), making the dedup itself
        // the slow path that the dedup is supposed to prevent.  The
        // backend always replaces the last tool_call object when the
        // call mutates, so reference inequality catches the same case
        // in O(1) without serialising anything.
        && existing.metrics.tool_calls[existing.metrics.tool_calls.length - 1]
          === action.session.metrics.tool_calls[action.session.metrics.tool_calls.length - 1]
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
      // Remove panes displaying this session from layout — except the
      // focused one: it shows the session that becomes active instead
      // (when no other pane shows it), so the window never falls back to
      // the empty welcome page while the title and the list name another
      // session as active.
      let newRoot = state.layout.root;
      if (newRoot) {
        const panes = collectPanes(newRoot);
        const focused = panes.find((p) => p.id === state.layout.focusedPaneId);
        const next = state.activeSessionId && state.activeSessionId !== action.id && rest[state.activeSessionId]
          ? state.activeSessionId
          : (ids.length > 0 ? ids[ids.length - 1] : null);
        if (focused && focused.sessionId === action.id && next && !panes.some((p) => p.sessionId === next)) {
          newRoot = setPaneSession(newRoot, focused.id, next);
        }
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
      // Clean per-session injection lock
      const { [action.id]: _lock, ...restLocks } = state.injectionLocks;
      const { [action.id]: _composer, ...restComposers } = state.composers;
      // Drop the closed session's notes — keeps saved_workspace.json
      // from accumulating dead session-id keys when sessions are removed
      // (cf. workbenchLayout.serializeNotesMap which also drops empty
      // strings, but that path only fires when the user clears a note;
      // SESSION_REMOVED is the canonical "this id no longer exists").
      const { [action.id]: _note, ...restNotes } = state.notes;
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
        injectionLocks: restLocks,
        composers: restComposers,
        notes: restNotes,
        pendingCloseSessionId: newPendingClose,
        layout: { root: newRoot, focusedPaneId: newFocused },
        ui: {
          ...state.ui,
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
      // Right rail is single-panel: opening Context closes Usage and Track.
      return {
        ...state,
        ui: {
          ...state.ui,
          contextPanelOpen: !state.ui.contextPanelOpen,
          usagePanelOpen: state.ui.contextPanelOpen ? state.ui.usagePanelOpen : false,
          trackPanelOpen: state.ui.contextPanelOpen ? state.ui.trackPanelOpen : false,
        },
      };
    case "TOGGLE_USAGE":
      return {
        ...state,
        ui: {
          ...state.ui,
          usagePanelOpen: !state.ui.usagePanelOpen,
          contextPanelOpen: state.ui.usagePanelOpen ? state.ui.contextPanelOpen : false,
          trackPanelOpen: state.ui.usagePanelOpen ? state.ui.trackPanelOpen : false,
        },
      };
    case "TOGGLE_TRACK":
      // Opening the Track panel closes Context and Usage (same column).
      return {
        ...state,
        ui: {
          ...state.ui,
          trackPanelOpen: !state.ui.trackPanelOpen,
          contextPanelOpen: state.ui.trackPanelOpen ? state.ui.contextPanelOpen : false,
          usagePanelOpen: state.ui.trackPanelOpen ? state.ui.usagePanelOpen : false,
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
    case "TOGGLE_AUTO_APPLY":
      return { ...state, autoApplyEnabled: !state.autoApplyEnabled };
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
    case "TILE_SESSIONS": {
      const ids = action.sessionIds.filter((id) => !!state.sessions[id]);
      const root = tileLayout(ids);
      if (!root) return state;
      workspaceDirty = true;
      const first = collectPanes(root)[0];
      return {
        ...state,
        activeSessionId: first.sessionId,
        layout: { root, focusedPaneId: first.id },
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

    // ─── Right-rail Workbench (1.1.14, agent-mode only) ──────────────
    case "TOGGLE_WORKBENCH": {
      workspaceDirty = true;
      return {
        ...state,
        ui: {
          ...state.ui,
          workbench: { ...state.ui.workbench, open: !state.ui.workbench.open },
        },
      };
    }
    case "SET_WORKBENCH_OPEN": {
      if (state.ui.workbench.open === action.open) return state;
      workspaceDirty = true;
      return {
        ...state,
        ui: {
          ...state.ui,
          workbench: { ...state.ui.workbench, open: action.open },
        },
      };
    }
    case "SET_WORKBENCH_TAB": {
      if (state.ui.workbench.tab === action.tab) return state;
      workspaceDirty = true;
      return {
        ...state,
        ui: {
          ...state.ui,
          workbench: { ...state.ui.workbench, tab: action.tab },
        },
      };
    }
    case "SET_WORKBENCH_RATIO": {
      const ratio = clampWorkbenchRatio(action.ratio);
      if (state.ui.workbench.ratio === ratio) return state;
      workspaceDirty = true;
      return {
        ...state,
        ui: { ...state.ui, workbench: { ...state.ui.workbench, ratio } },
      };
    }
    case "SET_WORKBENCH_FILES_NOTES_SPLIT": {
      const r = clampFilesNotesSplit(action.ratio);
      if (state.ui.workbench.filesNotesSplit === r) return state;
      workspaceDirty = true;
      return {
        ...state,
        ui: {
          ...state.ui,
          workbench: { ...state.ui.workbench, filesNotesSplit: r },
        },
      };
    }
    case "SET_SESSION_NOTE": {
      const content = clampNoteContent(action.content);
      // Reference-equal short-circuit: typing the same value twice in
      // a row (e.g., a debounced flush after no-op input) shouldn't
      // mark the workspace dirty or trigger downstream re-renders.
      if (state.notes[action.sessionId] === content) return state;
      workspaceDirty = true;
      return {
        ...state,
        notes: { ...state.notes, [action.sessionId]: content },
      };
    }
    case "RESTORE_WORKBENCH": {
      // Replaces the whole workbench slice + notes map.  Used once at
      // workspace restore.  We do NOT set workspaceDirty here — the
      // restore is itself loading from disk, and dirtying immediately
      // would re-write the file with logically-identical content.
      return {
        ...state,
        notes: { ...action.notes },
        ui: {
          ...state.ui,
          workbench: {
            open: action.layout.open,
            tab: action.layout.tab,
            ratio: clampWorkbenchRatio(action.layout.ratio),
            filesNotesSplit: clampFilesNotesSplit(action.layout.filesNotesSplit),
          },
        },
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
  autoApplyEnabled: true,
  injectionLocks: {},
  composers: {},
  notes: {},
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
    trackPanelOpen: false,
    sessionListCollapsed: false,
    commandPaletteOpen: false,
    flowMode: false,
    processPanelOpen: false,
    gitPanelOpen: false,
    fileExplorerOpen: false,
    searchPanelOpen: false,
    composerOpen: false,
    activeLeftTab: "terminal" as const,
    filePreview: null,
    // Right-rail Workbench (agent-mode only) — defaults to OPEN per
    // user spec, 50/50 chat/workbench, Files tab active, files take 70%
    // of the vertical space.  Persisted in saved_workspace.json.
    workbench: {
      open: true,
      tab: "files" as const,
      ratio: 0.5,
      filesNotesSplit: 0.7,
    },
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

// The context object lives in its own module (see sessionContextObject.ts).
const SessionContext = SessionContextObject as React.Context<SessionContextValue | null>;

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(sessionReducer, initialState);
  // Mirrors `workspaceLoaded` for the hooks that save on a change.
  const [workspaceReady, setWorkspaceReady] = useState(workspaceLoaded);
  const busyTimestamps = useRef<Map<string, number>>(new Map());
  const lastAutoAttachCwd = useRef<Map<string, string>>(new Map());
  const closingSessionIds = useRef<Set<string>>(new Set());
  const closeTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Saved sessions that could not be restored this launch. They go back
  // into the saved workspace (tried again next start) unless the user
  // chooses to forget one from the error message.
  const unrestoredSessions = useRef<SavedSessionInfo[]>([]);
  useEffect(() => {
    const onForget = (e: Event) => {
      const { id } = (e as CustomEvent<{ id: string }>).detail;
      unrestoredSessions.current = unrestoredSessions.current.filter((s) => s.id !== id);
      workspaceDirty = true;
    };
    window.addEventListener("hermes:session-restore-forget", onForget);
    return () => window.removeEventListener("hermes:session-restore-forget", onForget);
  }, []);
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
  /** Per-session respawn lock: overlapping plain restarts join one restart
   *  (see utils/respawnQueue.ts). */
  const respawnQueue = useRef(createRespawnQueue());
  /** sessionId → "already auto-named, don't try again". Prevents racing
   *  duplicate label writes if the user submits two messages in quick
   *  succession before the first persist round-trip completes. */
  const autoNamedSessions = useRef<Set<string>>(new Set());
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
            // Bug 5 (1.2.x): mirror the init into the module-level
            // cache `useAgentInit` reads on mount.  The init event
            // fires ONCE per spawn and Tauri does not replay to late
            // subscribers; without this write, the composer's
            // model/permission/effort chips vanish for any session
            // the user navigates to after its initial spawn.
            cacheAgentInit(sessionId, event);
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
              // Mirror the bridge's reported permission_mode into the
              // React session state too — covers the case where the
              // mode flipped without a chip click (EnterPlanMode /
              // ExitPlanMode tools, /model slash command, etc.).  The
              // optimistic dispatch in switchAgentPermissionMode covers
              // the chip path; this covers everything else.
              const existing = stateRef.current.sessions[sessionId];
              if (existing && existing.permission_mode !== event.permissionMode) {
                dispatch({
                  type: "SESSION_UPDATED",
                  session: { ...existing, permission_mode: event.permissionMode },
                });
              }
            }
            // Patch the cached init snapshot too so a late-mounting
            // composer (e.g. switching to the session AFTER plan-mode
            // was entered) sees the current permissionMode, not the
            // stale spawn-time value.
            const cached = peekAgentInitCache(sessionId);
            if (cached) {
              const patched = { ...cached };
              if (typeof event.model === "string") patched.model = event.model;
              if (typeof event.permissionMode === "string") {
                patched.permissionMode = event.permissionMode;
              }
              cacheAgentInit(sessionId, patched);
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

  // ─── Branch-in-use choice (honest isolation) ─────────────────────────
  // createSession awaits the user's answer; the dialog resolves it.
  const [pendingBranchConflict, setPendingBranchConflict] = useState<{
    conflict: BranchInUse & { projectId: string };
    heldBy: string;
    /** The repository's local branches, so a new name that is one is refused. */
    localBranches: string[];
    resolve: (choice: BranchConflictChoice) => void;
  } | null>(null);

  // ─── Dirty worktree close state ─────────────────────────────────────
  const [pendingDirtyClose, setPendingDirtyClose] = useState<{
    sessionId: string;
    label: string;
    changes: DirtyWorktreeChange[];
    stashErrors?: Array<{ projectName: string; error: string }>;
    /** The session's program was running when the dialog opened. */
    agentWorking?: boolean;
    /** The session was already stopped; these folders (project → path) are still to be saved. */
    closed?: boolean;
    kept?: Record<string, string>;
    /** A commit hook refused the commit (shown with "Archive instead"). */
    hookRefusal?: PendingHookRefusal | null;
  } | null>(null);

  // ─── Sessions that ended without Hermes closing them ────────────────
  const endedBurst = useRef<{ ids: Set<string>; sessions: Map<string, SessionData>; timer: ReturnType<typeof setTimeout> | null }>({
    ids: new Set(),
    sessions: new Map(),
    timer: null,
  });
  const settleEndedBurst = useCallback(async () => {
    const burst = endedBurst.current;
    const ended = [...burst.ids].map((id) => burst.sessions.get(id)).filter((s): s is SessionData => !!s);
    burst.ids.clear();
    burst.sessions.clear();
    burst.timer = null;
    const live = ended.filter((s) => stateRef.current.sessions[s.id] && !closingSessionIds.current.has(s.id));
    if (live.length === 0) return;
    let hostGone = false;
    try {
      const st = await sessionHostStatus();
      hostGone = st.supported && !st.running && live.some((s) => st.hosted_session_ids.length === 0 || !st.hosted_session_ids.includes(s.id));
    } catch {
      // Unknown: decide by the count alone.
    }
    if (endedSessionsVerdict({ count: live.length, hostGone }) === "close") {
      for (const s of live) {
        closingSessionIds.current.add(s.id);
        apiCloseSession(s.id).catch(() => closingSessionIds.current.delete(s.id));
      }
      return;
    }
    // Keep them, ended, with their output; one notice for all of them.
    for (const s of live) dispatch({ type: "SESSION_UPDATED", session: s });
    window.dispatchEvent(new CustomEvent("hermes:sessions-ended", {
      detail: { sessions: live.map((s) => ({ id: s.id, label: s.label })), reason: "service" },
    }));
  }, []);
  // Read from the mount-once event listener below.
  const settleEndedBurstRef = useRef(settleEndedBurst);
  settleEndedBurstRef.current = settleEndedBurst;

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
          if (closingSessionIds.current.has(session.id)) return;
          if (!stateRef.current.sessions[session.id]) {
            // Never shown: nothing to keep.
            closingSessionIds.current.add(session.id);
            apiCloseSession(session.id).catch(() => {
              closingSessionIds.current.delete(session.id);
            });
            return;
          }
          // It ended without Hermes closing it. Decide once the burst is
          // over: several at once, or the terminal service gone, is a crash
          // (the rows stay, ended, with their output); one program that
          // ended on its own closes as before.
          endedBurst.current.ids.add(session.id);
          endedBurst.current.sessions.set(session.id, session);
          if (!endedBurst.current.timer) {
            endedBurst.current.timer = setTimeout(() => void settleEndedBurstRef.current(), ENDED_BURST_MS);
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
            // Only notify if the window is not focused. With the attention
            // inbox on, "done" notifications come from the inbox instead
            // (grouped per session, never for the session you look at).
            if (document.hidden && !isFeatureFlagEnabled("attentionInbox")) {
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
          // NOTE: an earlier draft (Bug C) auto-respawned the bridge here
          // when `hasAddDirDrift(claudeAddDirs.current, workspace_paths)`
          // was true, so file tools would see freshly-attached projects
          // before the next message.  That created an infinite respawn
          // loop because `claudeAddDirs.current` is only updated inside
          // `submitAgentMessage` — every fresh bridge re-emitted the same
          // wp-event and the drift check kept triggering another respawn.
          // The drift check inside `submitAgentMessage` already handles
          // the next-turn case correctly; the gap (attach without submit)
          // is rare and harmless (Read/Edit will fail clearly until the
          // user sends a message), so no auto-respawn here.
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
        // H2 + H3 fix (v1.1.2): single canonical cleanup of every
        // per-session ref + cancellation of the 500ms close-fallback
        // timer.  Previously claudeAddDirs / lastIdeStateHash /
        // lastAutoAttachCwd were never cleared, leaking unbounded
        // for the lifetime of the app, and the close-fallback timer
        // fired after the real event left a stale SESSION_REMOVED.
        cleanupSessionRefs(
          {
            busyTimestamps: busyTimestamps.current,
            closingSessionIds: closingSessionIds.current,
            closeTimers: closeTimers.current,
            lastAutoAttachCwd: lastAutoAttachCwd.current,
            claudeUuids: claudeUuids.current,
            claudeModels: claudeModels.current,
            claudePermissionModes: claudePermissionModes.current,
            claudeEfforts: claudeEfforts.current,
            claudeAddDirs: claudeAddDirs.current,
            pendingFlags: pendingFlags.current,
            lastIdeStateHash: lastIdeStateHash.current,
            autoNamedSessions: autoNamedSessions.current,
          },
          event.payload,
        );
        // Drop the per-session agent-event listener.
        detachInitListener(event.payload);
        // Tear down the long-lived agent message store so its Tauri
        // listeners don't leak after the session is gone.
        destroyAgentSessionStore(event.payload);
        // Release the module-level init cache entry (Bug 5 fix) —
        // otherwise the Map grows unbounded across long-running app
        // sessions.
        clearAgentInitCache(event.payload);
        // Forget its 2.0 session events: whatever waited on it (a usage
        // limit in the inbox, N19) goes with it.
        clearSessionEvents(event.payload);
        dispatch({ type: "SESSION_REMOVED", id: event.payload });
      });
      unlisteners.push(u2);

      // Note: project context nudge is now handled by ProjectPicker on close,
      // to avoid duplicate instructions when toggling multiple projects.
    };

    setup().catch((err) => console.error("[SessionContext] Failed to setup event listeners:", err));

    const markWorkspaceLoaded = () => {
      workspaceLoaded = true;
      setWorkspaceReady(true);
    };

    // Load settings first, THEN sessions (so terminals use correct settings)
    getSettings()
      .then((s) => {
        const theme = s.theme || "frosted-dark";
        applyTheme(theme, s);
        applyAgentTimelineStyle(s.agent_timeline_style);
        restoreWindowState(s).catch(console.error);

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
        for (const session of live) markStartupSession(session.id);
        if (live.length > 0) {
          dispatch({ type: "SET_ACTIVE", id: live[0].id });
          markWorkspaceLoaded();
          return;
        }

        // Guard against React StrictMode double-mount: the first mount's
        // load marks the workspace loaded when it is done.
        if (workspaceRestoreStarted) return;
        workspaceRestoreStarted = true;

        // No live sessions — attempt workspace restore
        const restorePref = s.restore_sessions || "always";
        const savedJson = s.saved_workspace;
        if (restorePref === "never" || !savedJson) {
          if (savedJson) keepSavedWorkspace = true;
          markWorkspaceLoaded();
          return;
        }
        workspaceRestoreInProgress = true;
        // Cleared below once a session is restored.
        keepSavedWorkspace = true;

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
          const usedRestoreIds = new Set<string>();
          for (const saved of workspace.sessions) {
            // Keep the saved id so the session keeps its worktree link
            // (session_worktrees rows are keyed by it) and its history.
            const restoreId = pickRestoreId(saved.id, usedRestoreIds);
            usedRestoreIds.add(restoreId);
            try {
              // Read the scrollback BEFORE creating the session: creating it
              // under the same id rewrites its row, snapshot included.
              let savedSnapshot: string | null = null;
              try {
                savedSnapshot = await getSessionSnapshot(saved.id);
              } catch {
                console.warn("[SessionContext] Failed to read scrollback for", saved.label);
              }
              // Pre-generate ID and set up listener before PTY starts
              // (same race-prevention as createSession above). What the new
              // shell prints is held until the restored scrollback is in.
              await createTerminal(restoreId, saved.color, { holdOutput: true });

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
                agentName: saved.agent_name || null,
                agentCommand: saved.agent_command || null,
                sshHost: saved.ssh_info?.host || null,
                sshPort: saved.ssh_info?.port || null,
                sshUser: saved.ssh_info?.user || null,
                tmuxSession: saved.ssh_info?.tmux_session || null,
                sshIdentityFile: saved.ssh_info?.identity_file || null,
                sshJumpHost: saved.ssh_info?.jump_host || null,
                initialRows: restoreDims.rows,
                initialCols: restoreDims.cols,
                mode: restoredMode,
                // Terminal-agent resume (launchHelper flag): hand the saved
                // conversation id back so the agent continues it.
                launchHelper: isFeatureFlagEnabled("launchHelper"),
                launchHelperRequired: isFeatureFlagEnabled("launchHelper"),
                featureTracks: isFeatureFlagEnabled("featureTracks"),
                vendorSessionId: saved.vendor_session_id ?? null,
                // 2.0: resume in the same profile with the same model and effort.
                agentLaunch: saved.agent_launch ? { ...saved.agent_launch, purpose: "agent" } : null,
                // Session host (sessionHost flag): reattach to the program
                // the host kept running under this id, if it still has it.
                sessionHost: isFeatureFlagEnabled("sessionHost"),
                parentSessionId: saved.parent_session_id ? (oldToNew.get(saved.parent_session_id) ?? saved.parent_session_id) : null,
              });
              // The restored scrollback first, then what the new shell has
              // printed so far — unless the session host replayed the real
              // output (N20): the terminal then shows everything, live.
              releaseOutput(restoreId, savedSnapshot && !newSession.reattached ? savedSnapshot : null);
              // Restored at startup: an agent of it already waiting opens the morning view.
              markStartupSession(newSession.id);

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
                // Claude resumes with the context but streams only what comes
                // next: draw the earlier conversation from its transcript.
                if (saved.claude_session_uuid) {
                  getAgentHistory(newSession.working_directory, saved.claude_session_uuid)
                    .then((history) => {
                      if (history.length === 0) return;
                      getOrCreateAgentSessionStore(newSession.id, listen).seedHistory(history as AgentEvent[]);
                    })
                    .catch((err) => console.warn("[SessionContext] Failed to read the earlier conversation:", err));
                }
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
                    void reportAgentSpawnFailure({
                      sessionId: newSession.id,
                      error: err,
                      context: "restore",
                    });
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

              dispatch({ type: "SESSION_UPDATED", session: newSession });
              if (newSession.reattached) {
                // The replayed output may already have moved the phase on
                // (the program is busy); the create result is stale by now.
                getSessions()
                  .then((all) => {
                    const fresh = all.find((x) => x.id === newSession.id);
                    if (fresh) dispatch({ type: "SESSION_UPDATED", session: fresh });
                  })
                  .catch(() => {});
              }
              oldToNew.set(saved.id, newSession.id);
            } catch (err) {
              console.warn("[SessionContext] Failed to restore session:", saved.label, err);
              // Clean up the terminal that was pre-created for this failed session
              destroyTerminal(restoreId);
              // The backend announces a session before its shell starts; if
              // the start failed, that entry would stay at "starting" for
              // ever. Drop it from the list, keep its saved entry for the
              // next launch, and say why.
              dispatch({ type: "SESSION_REMOVED", id: restoreId });
              unrestoredSessions.current = [...unrestoredSessions.current.filter((s) => s.id !== saved.id), saved];
              window.dispatchEvent(new CustomEvent("hermes:session-restore-failed", {
                detail: { id: saved.id, label: saved.label, error: err instanceof Error ? err.message : String(err) },
              }));
            }
          }

          if (oldToNew.size === 0) return;
          keepSavedWorkspace = false;

          // Restore the right-rail Workbench layout + per-session notes
          // (1.1.14).  Notes are remapped through the same old→new id
          // map as everything else so a session restored under a fresh
          // uuid still sees its scratchpad.  Older saves (no
          // `workbench` / `notes` fields) fall through to defaults.
          {
            const layout = loadWorkbenchLayout(workspace.workbench);
            const rawNotes = loadNotesMap(workspace.notes);
            const remappedNotes: Record<string, string> = {};
            for (const [oldId, content] of Object.entries(rawNotes)) {
              const newId = oldToNew.get(oldId);
              if (newId) remappedNotes[newId] = content;
            }
            dispatch({
              type: "RESTORE_WORKBENCH",
              layout,
              notes: remappedNotes,
            });
          }

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

          // The saved workspace is NOT cleared here: sessions keep their
          // saved ids, so restoring it again is harmless, and a quit before
          // the next write must still find it. Marking the workspace loaded
          // writes the restored state right away (useSaveWorkspaceOnChange).
        } finally {
          workspaceRestoreInProgress = false;
          markWorkspaceLoaded();
        }
      })
      .catch((err) => {
        workspaceRestoreInProgress = false;
        // The launch could not even read what was saved: never write an
        // empty workspace over it (a session opened later clears this).
        keepSavedWorkspace = true;
        markWorkspaceLoaded();
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
      let reusedCheckouts: ReusedCheckout[] = [];
      let worktreeErrors: string[] = [];
      // Bug 3 (1.2.x): count successes so we can abort if EVERY worktree
      // failed.  Previously the loop swallowed every error and let
      // `apiCreateSession` proceed; the backend silently used the
      // project root and the agent session booted with no isolation.
      let worktreesSucceeded = 0;
      if (opts?.branchSelections && opts?.projectIds?.length) {
        // A branch that is checked out elsewhere is never shared silently:
        // the backend refuses, and with honest isolation on the user
        // chooses (reuse / new branch / cancel). With the flag off, stable
        // keeps its old behaviour of sharing that checkout — now recorded
        // as shared, so closing this session can never delete it.
        const askUser = isFeatureFlagEnabled("honestIsolation");
        const created: CreatedWorktree[] = [];
        const worktreeWarnings: Array<{ projectId: string; warning: string }> = [];
        const outcome = await createSessionWorktrees(preSessionId, opts.projectIds, opts.branchSelections, {
          createWorktree: async (sessionId, projectId, branch, createNew, fromRemote, baseBranch) => {
            const r = await createWorktree(sessionId, projectId, branch, createNew, fromRemote, baseBranch);
            if (!r.isMainWorktree) created.push({ projectId, branch: r.branchName, worktreePath: r.worktreePath });
            // Made, but a hook failed after git checked it out: say so.
            if (r.warning) worktreeWarnings.push({ projectId, warning: r.warning });
            return r;
          },
          attachWorktree,
          removeWorktree,
          detachWorktree,
          removeLeftover: (projectId, path) => removeLeftoverWorktree(projectId, path, null),
          resolveConflict: async (conflict) => {
            if (!askUser) return { kind: "reuse" };
            const holder = conflict.sessionId ? stateRef.current.sessions[conflict.sessionId] : undefined;
            const heldBy = describeBranchHolder(conflict, holder?.label ?? null);
            // Without the list the backend still refuses such a name.
            const localBranches = await gitListBranchesForProject(conflict.projectId)
              .then((all) => all.filter((b) => !b.is_remote).map((b) => b.name))
              .catch(() => [] as string[]);
            return new Promise<BranchConflictChoice>((resolve) => {
              setPendingBranchConflict({ conflict, heldBy, localBranches, resolve });
            });
          },
        });
        if (outcome.cancelled) {
          destroyTerminal(preSessionId);
          return null;
        }
        worktreesSucceeded = outcome.succeeded;
        // People read project names, not ids, and sentences, not libgit2 codes.
        const names = await projectNamesById(opts.projectIds);
        worktreeErrors = outcome.errors.map((e) => plainGitError(e, names));
        reusedCheckouts = outcome.reused;
        if (worktreeWarnings.length > 0) {
          window.dispatchEvent(new CustomEvent("hermes:worktree-warnings", {
            detail: { warnings: worktreeWarnings.map((w) => `${names[w.projectId] ?? "A project"}: ${w.warning}`) },
          }));
        }
        for (const e of worktreeErrors) console.warn(`[SessionContext] Failed to create worktree: ${e}`);

        // Hard-abort when every selected worktree failed.  Returning
        // null here surfaces the failure to the caller (command palette
        // / NewSessionButton) instead of silently creating a session on
        // the wrong branch.  Note: the legacy `opts?.branchName` path
        // below intentionally does NOT participate in this gate — it
        // pre-dates the branch-selections API and is best-effort by
        // design.
        if (worktreeFailureIsFatal({
          succeeded: worktreesSucceeded,
          errorCount: worktreeErrors.length,
        })) {
          destroyTerminal(preSessionId);
          window.dispatchEvent(new CustomEvent("hermes:worktree-errors", {
            detail: { errors: worktreeErrors, sessionLabel: opts?.label, fatal: true },
          }));
          return null;
        }

        // Worktree recipes (.hermes/worktree.toml): prepare each new
        // worktree before anything starts in it. Part of honest isolation,
        // so it ships behind the same flag. No file: nothing happens.
        if (created.length > 0 && isFeatureFlagEnabled("honestIsolation")) {
          await runWorktreeRecipes(preSessionId, created);
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

      // Pick the runtime mode.  Terminal is the default for every provider;
      // the Agent view is used only when the caller asked for it and the
      // provider has one (Claude today).
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
        agentName: opts?.agentName || null,
        agentCommand: opts?.agentCommand || null,
        channels: opts?.channels || null,
        sshHost: opts?.sshHost || null,
        sshPort: opts?.sshPort || null,
        sshUser: opts?.sshUser || null,
        tmuxSession: opts?.tmuxSession || null,
        sshIdentityFile: opts?.sshIdentityFile || null,
        sshJumpHost: opts?.sshJumpHost || null,
        initialRows: initialDims.rows,
        initialCols: initialDims.cols,
        mode,
        // A launcher task travels as an argument, which only the helper can
        // pass without any shell quoting.
        launchHelper: isFeatureFlagEnabled("launchHelper") || (mode === "terminal" && (!!opts?.initialPrompt?.trim() || !!opts?.systemPrompt?.trim() || !!opts?.agentLaunch)),
        launchHelperRequired: isFeatureFlagEnabled("launchHelper"),
        featureTracks: isFeatureFlagEnabled("featureTracks"),
        sessionHost: isFeatureFlagEnabled("sessionHost"),
        initialPrompt: mode === "terminal" ? opts?.initialPrompt?.trim() || null : null,
        systemPrompt: mode === "terminal" ? opts?.systemPrompt?.trim() || null : null,
        seedPrompt: opts?.seedPrompt || null,
        parentSessionId: opts?.parentSessionId || null,
        // 2.0: the model, effort and account (and "login" for Add account)
        // travel in the launch file, so only the helper can carry them.
        agentLaunch: mode === "terminal" ? opts?.agentLaunch ?? null : null,
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
        // Task launcher (F15): the task is the conversation's first message,
        // sent once the agent is up.
        const firstMessage = opts?.initialPrompt?.trim() ? buildUserEnvelope(opts.initialPrompt.trim(), []) : null;
        spawnAgentSession({
          sessionId: session.id,
          workingDir: session.working_directory,
          addDirs: session.workspace_paths,
        })
          .then(async (uuid) => {
            claudeUuids.current.set(session.id, uuid);
            if (!firstMessage) return;
            try {
              await echoUserEnvelope(session.id, firstMessage);
              await sendUserEnvelope(session.id, firstMessage);
            } catch (err) {
              console.warn("[SessionContext] Failed to send the task as the first message:", err);
            }
          })
          .catch((err) => {
            console.error("[SessionContext] Failed to spawn Claude agent:", err);
            void reportAgentSpawnFailure({
              sessionId: session.id,
              error: err,
              context: "create",
            });
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
        has_ai_provider: !!opts?.aiProvider,
      });

      // Say what reusing a checkout means via custom event (App.tsx listens for this)
      if (reusedCheckouts.length > 0) {
        window.dispatchEvent(new CustomEvent("hermes:shared-worktree", {
          detail: { reused: reusedCheckouts, sessionLabel: session.label },
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
    // Snapshot the mode BEFORE the backend tears down session state.
    // After close_session emits `session-removed` and the reducer drops
    // the entry, `state.sessions[id]` is gone and we can't tell whether
    // we needed to kill an agent subprocess too.
    const mode = stateRef.current.sessions[id]?.mode ?? "terminal";
    try {
      await performAgentAwareClose(id, mode);
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

  const skipCloseConfirmRef = useRef(state.skipCloseConfirm);
  skipCloseConfirmRef.current = state.skipCloseConfirm;

  const requestCloseSession = useCallback(async (id: string) => {
    try {
      // Check for dirty worktrees before proceeding with close flow
      try {
        const projects = await getSessionProjects(id);
        const dirtyChanges: DirtyWorktreeChange[] = [];

        const honest = isFeatureFlagEnabled("honestIsolation");
        for (const project of projects) {
          // Only a checkout this session owns alone is deleted on close,
          // so only its changes need a decision. A checkout shared with
          // another session (or, with honest isolation, the project
          // folder) is left as it is, changes included.
          let wtInfo: SessionWorktree | null = null;
          try {
            wtInfo = await getSessionWorktreeInfo(id, project.id);
          } catch {
            // Worktree info not available — continue without it
          }
          if (!shouldAskAboutChangesOnClose(wtInfo, honest)) continue;
          // A check that fails is a question too (never a silent delete).
          const entry = await closeCheckEntry(id, project, wtInfo?.branchName ?? null, worktreeHasChanges);
          if (entry) dirtyChanges.push(entry);
        }

        if (dirtyChanges.length > 0) {
          const session = stateRef.current.sessions[id];
          const label = session?.label || id;
          setPendingDirtyClose({ sessionId: id, label, changes: dirtyChanges, agentWorking: session?.phase === "busy" });
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
  // The choice made in the Uncommitted Changes dialog is the confirmation:
  // no second "Close session?" follows it.

  /** Folders kept on disk (not deleted on close): say where they are. */
  const announceKept = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    window.dispatchEvent(new CustomEvent("hermes:worktrees-kept", { detail: { paths } }));
  }, []);

  const handleDirtyStashAndClose = useCallback(async () => {
    if (!pendingDirtyClose) return;
    const { sessionId, changes } = pendingDirtyClose;
    const failures: Array<{ projectName: string; error: string }> = [];
    for (const change of changes) {
      if (change.files.length === 0) continue;
      try {
        await stashWorktree(sessionId, change.projectId, "Auto-stash before closing session");
      } catch (e) {
        console.warn("[SessionContext] Failed to stash worktree:", e);
        failures.push({ projectName: change.projectName, error: plainGitError(e) });
      }
    }
    if (failures.length > 0) {
      // Do NOT close — show errors in the dialog so the user can decide
      setPendingDirtyClose((prev) => prev ? { ...prev, stashErrors: failures } : null);
      return;
    }
    setPendingDirtyClose(null);
    closeSession(sessionId);
  }, [pendingDirtyClose, closeSession]);

  /**
   * Save the work, then close: the session's link to each worktree goes
   * first (so stopping it leaves the folders), the session — and the agent
   * in it — stops, and only then is each folder committed ("session" on the
   * branch the dialog named, "archive" on a new hermes-archive/ branch,
   * "detached" keeping a detached HEAD's commits on a branch) and removed.
   * Nothing the agent writes after the choice is lost. What cannot be
   * saved stays on disk and the dialog says why.
   */
  const saveDirtyAndClose = useCallback(async (kind: "session" | "archive" | "detached") => {
    if (!pendingDirtyClose) return;
    const pending = pendingDirtyClose;
    const { sessionId, label, changes } = pending;
    const message = closeCommitMessage(label, kind === "archive" ? "archive" : "session");
    const kept: Record<string, string> = { ...(pending.kept ?? {}) };
    if (!pending.closed) {
      const failures: Array<{ projectName: string; error: string }> = [];
      for (const c of changes) {
        if (kept[c.projectId]) continue;
        try {
          kept[c.projectId] = await keepWorktree(sessionId, c.projectId);
        } catch (e) {
          failures.push({ projectName: c.projectName, error: plainGitError(e) });
        }
      }
      if (failures.length > 0) {
        setPendingDirtyClose((prev) => prev ? { ...prev, kept, stashErrors: failures } : null);
        return;
      }
      await closeSession(sessionId);
    }

    const remaining: Record<string, string> = {};
    const keptForGood: string[] = [];
    const failures: Array<{ projectName: string; error: string }> = [];
    let refusal: PendingHookRefusal | null = null;
    for (const c of changes) {
      const path = kept[c.projectId];
      if (!path) continue;
      // Edits inside a submodule cannot be committed from here, and a
      // worktree that could not be checked is never deleted.
      if (c.checkError || (c.dirtySubmodules?.length ?? 0) > 0) {
        keptForGood.push(path);
        continue;
      }
      try {
        if (c.detached && ((c.lostCommits ?? 0) > 0 || c.files.length > 0)) {
          await saveKeptDetachedHead(c.projectId, path, c.branchName, c.files.length > 0 ? message : null);
        } else if (c.files.length > 0) {
          await commitKeptWorktree(
            c.projectId,
            path,
            message,
            kind === "archive" ? "archive" : "session",
            kind === "archive" ? null : (c.actualBranch ?? c.branchName),
          );
        }
        // An archive leaves the files as they were (they are on the
        // hermes-archive/ branch now): the folder may go with them.
        await removeLeftoverWorktree(c.projectId, path, sessionId, kind === "archive" && c.files.length > 0);
      } catch (e) {
        remaining[c.projectId] = path;
        const hook = parseHookRefusal(e);
        if (hook && !refusal) refusal = { projectName: c.projectName, ...hook };
        else failures.push({ projectName: c.projectName, error: plainGitError(e) });
      }
    }
    announceKept(keptForGood);
    if (Object.keys(remaining).length > 0) {
      setPendingDirtyClose((prev) => prev ? {
        ...prev,
        closed: true,
        kept: remaining,
        changes: prev.changes.filter((c) => remaining[c.projectId]),
        hookRefusal: refusal,
        stashErrors: failures.length > 0 ? failures : undefined,
      } : null);
      return;
    }
    setPendingDirtyClose(null);
  }, [pendingDirtyClose, closeSession, announceKept]);

  const handleDirtyCommitAndClose = useCallback(() => saveDirtyAndClose("session"), [saveDirtyAndClose]);
  const handleDirtyArchiveAndClose = useCallback(() => saveDirtyAndClose("archive"), [saveDirtyAndClose]);
  const handleDirtySaveDetachedAndClose = useCallback(() => saveDirtyAndClose("detached"), [saveDirtyAndClose]);

  /** Keep every worktree in the dialog on disk (with its branch) and close. */
  const handleDirtyKeepAndClose = useCallback(async () => {
    if (!pendingDirtyClose) return;
    const { sessionId, changes } = pendingDirtyClose;
    const paths: string[] = Object.values(pendingDirtyClose.kept ?? {});
    if (!pendingDirtyClose.closed) {
      const failures: Array<{ projectName: string; error: string }> = [];
      for (const c of changes) {
        try {
          paths.push(await keepWorktree(sessionId, c.projectId));
        } catch (e) {
          failures.push({ projectName: c.projectName, error: plainGitError(e) });
        }
      }
      if (failures.length > 0) {
        setPendingDirtyClose((prev) => prev ? { ...prev, stashErrors: failures } : null);
        return;
      }
      setPendingDirtyClose(null);
      await closeSession(sessionId);
    } else {
      setPendingDirtyClose(null);
    }
    announceKept(paths);
  }, [pendingDirtyClose, closeSession, announceKept]);

  const handleDirtyCloseAnyway = useCallback(() => {
    if (!pendingDirtyClose) return;
    const { sessionId, closed } = pendingDirtyClose;
    setPendingDirtyClose(null);
    if (closed) {
      announceKept(Object.values(pendingDirtyClose.kept ?? {}));
      return;
    }
    // Discard: closing removes the worktree with everything in it.
    closeSession(sessionId);
  }, [pendingDirtyClose, closeSession, announceKept]);

  const handleDirtyCancelClose = useCallback(() => {
    // After the session was stopped, its folders stay where they are.
    if (pendingDirtyClose?.closed) announceKept(Object.values(pendingDirtyClose.kept ?? {}));
    setPendingDirtyClose(null);
  }, [pendingDirtyClose, announceKept]);

  const setActive = useCallback((id: string | null) => {
    dispatch({ type: "SET_ACTIVE", id });
  }, []);

  // stateRef is declared above closeSession
  stateRef.current = state;

  const writeWorkspace = useCallback(async () => {
    // Never save before the launch's restore has settled or during it —
    // we'd overwrite the saved workspace with an empty or partial one.
    if (!workspaceLoaded || workspaceRestoreInProgress) return;

    const current = stateRef.current;
    const liveSessions = Object.values(current.sessions).filter((s) => s.phase !== "destroyed");
    if (liveSessions.length === 0) {
      // Nothing was restored and no session was opened since: the saved
      // workspace is still the user's, not a stale one.
      if (keepSavedWorkspace) return;
    }
    if (liveSessions.length === 0 && unrestoredSessions.current.length === 0) {
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
            ...(s.agent_command ? { agent_name: s.agent_name ?? "", agent_command: s.agent_command } : {}),
            project_ids: projectIds,
            ssh_info: s.ssh_info || null,
            mode: s.mode ?? "terminal",
            // Only include agent fields when actually populated — keeps the
            // saved JSON small and avoids stamping stale defaults on
            // terminal-mode sessions.
            ...(claudeUuid ? { claude_session_uuid: claudeUuid } : {}),
            ...(s.vendor_session_id ? { vendor_session_id: s.vendor_session_id } : {}),
            ...(s.parent_session_id ? { parent_session_id: s.parent_session_id } : {}),
            // 2.0: a terminal agent's model, effort and account (not a sign-in session).
            ...(s.agent_launch && !s.agent_launch.login && (s.agent_launch.modelId || s.agent_launch.effort || s.agent_launch.accountId)
              ? { agent_launch: { modelId: s.agent_launch.modelId ?? null, effort: s.agent_launch.effort ?? null, accountId: s.agent_launch.accountId ?? null } }
              : {}),
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
        sessions: withUnrestoredSessions(sessionInfos, unrestoredSessions.current),
        layout: current.layout.root,
        focused_pane_id: current.layout.focusedPaneId,
        active_session_id: current.activeSessionId,
        // Right-rail Workbench layout (1.1.14) — persisted as a small
        // sub-object so older readers that don't recognise it pass it
        // through untouched.  serializeWorkbenchLayout clamps the
        // numeric fields, so a hand-edited workspace can't load us into
        // a wedged state.
        workbench: serializeWorkbenchLayout(current.ui.workbench),
        // Per-session notes (1.1.14) — empty strings dropped so the
        // file doesn't accumulate dead session-id keys.
        notes: serializeNotesMap(current.notes),
      };

      await setSetting("saved_workspace", JSON.stringify(workspace));
    } catch (err) {
      console.error("[SessionContext] Failed to save workspace:", err);
    }
  }, []);

  const saveWorkspace = useCallback((): Promise<void> => {
    const run = saveChain.then(() => writeWorkspace());
    saveChain = run.catch(() => {});
    return run;
  }, [writeWorkspace]);

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

    // Bug 4 (1.2.x): when the close half of the conversion is
    // `apiCloseSession` (terminal mode), Bug 1's unconditional cleanup
    // strips the session's worktree from disk AND from the
    // `session_worktrees` table.  The follow-up `spawnAgentSession`
    // would then boot in a deleted directory.  Snapshot the worktree
    // info BEFORE close so we can restore it after.
    //
    // The two helpers `snapshotPreservableWorktrees` and
    // `restorePreservedWorktrees` are exported from this file and unit-
    // tested in `convert-mode-worktree-preservation.test.ts` — keep them
    // and this call site in lock-step.
    const plan = planConversionWorktreeRestore({
      currentMode: session.mode,
      newMode,
    });
    const worktreeRestores: PreservedWorktreeEntry[] =
      plan === "restore-before-spawn"
        ? await snapshotPreservableWorktrees(sessionId)
        : [];

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

      // 1b. Restore worktrees the close just nuked (terminal → agent only).
      // Errors are non-fatal: we log and let the spawn proceed; the
      // backend will fall back to the project root and the user will see
      // a missing-isolation warning if Bug 3's defence-in-depth is
      // active.  Better than failing the conversion entirely.
      if (worktreeRestores.length > 0) {
        await restorePreservedWorktrees(sessionId, worktreeRestores);
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
          agentName: session.agent_name || null,
          agentCommand: session.agent_command || null,
          channels: session.channels.length > 0 ? session.channels : null,
          sshHost: session.ssh_info?.host || null,
          sshPort: session.ssh_info?.port || null,
          sshUser: session.ssh_info?.user || null,
          tmuxSession: session.ssh_info?.tmux_session || null,
          sshIdentityFile: session.ssh_info?.identity_file || null,
          sshJumpHost: session.ssh_info?.jump_host || null,
          mode: "terminal",
          launchHelper: isFeatureFlagEnabled("launchHelper"),
          launchHelperRequired: isFeatureFlagEnabled("launchHelper"),
          featureTracks: isFeatureFlagEnabled("featureTracks"),
          vendorSessionId: session.vendor_session_id ?? null,
          sessionHost: isFeatureFlagEnabled("sessionHost"),
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
  const respawnAgentNow = useCallback(async (
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

      // One backend call stops the old process and starts the new one under
      // the session's spawn lock: restarts that overlap (a double-clicked
      // Retry, a submit racing a card's reply) start a single process.
      const newUuid = await restartAgentSession({
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
      void reportAgentSpawnFailure({
        sessionId,
        error: err,
        context: "respawn",
      });
      return false;
    }
  }, [attachInitListener]);

  /** `respawnAgentNow` behind the per-session respawn lock. */
  const respawnAgent = useCallback((
    sessionId: string,
    overrides: {
      model?: string | null;
      permissionMode?: string | null;
      effort?: string | null;
    },
  ): Promise<boolean> => {
    const carriesSettings =
      overrides.model !== undefined ||
      overrides.permissionMode !== undefined ||
      overrides.effort !== undefined;
    return respawnQueue.current.run(
      sessionId,
      { joinable: !carriesSettings && !respawnJoinDisabledForTest() },
      () => respawnAgentNow(sessionId, overrides),
    );
  }, [respawnAgentNow]);

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
    // `null` means "no change requested" — bail out before touching the
    // bridge or queueing a flag.  Otherwise the queued `permissionMode: null`
    // would slip through `submitAgentMessage`'s `!== undefined` mustRespawn
    // check and trigger a fork-respawn for nothing.
    if (permissionMode === null) return true;
    // Two-step:
    //   (a) immediately tell the live bridge so an in-flight turn's
    //       tool calls honor the new mode without waiting for the user
    //       to send a new message.
    //   (b) queue the flag so a future respawn carries it.
    // Step (a) is best-effort — the bridge may have exited between turns,
    // in which case the queued flag in (b) is what brings it back.
    // Optimistic React-state update — flip session.permission_mode in
    // the store IMMEDIATELY so the AgentSessionView's auto-allow
    // effect (which keys off `state.sessions[id].permission_mode`)
    // can fire on the very next render, before the bridge has even
    // acknowledged the setPermissionMode op.  Without this, the chip
    // visually flips but a perm modal already on screen sits there
    // until you send a new message.
    const existing = stateRef.current.sessions[sessionId];
    if (existing && existing.permission_mode !== permissionMode) {
      dispatch({
        type: "SESSION_UPDATED",
        session: { ...existing, permission_mode: permissionMode },
      });
    }
    try {
      await setAgentPermissionMode(sessionId, permissionMode);
    } catch { /* bridge may be down between turns; queued flag will apply */ }
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
   * The Agent view runs a per-session Node bridge (the Claude Agent SDK
   * behind a stream-json wire format, see `src-tauri/bridge/`), and that
   * subprocess can exit between turns.  To keep a multi-turn conversation
   * alive we spawn a fresh child when needed, passing
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

    // Auto-name unnamed agent sessions from the first user message
    // (issue #1). Cheap heuristic — no model round-trip; the first
    // message is already a great summary. Fire-and-forget so the
    // persist doesn't block the send.
    if (!autoNamedSessions.current.has(sessionId)) {
      const sess = stateRef.current.sessions[sessionId];
      if (sess?.mode === "agent" && isDefaultSessionLabel(sess.label)) {
        const derived = deriveSessionLabelFromMessage(draft);
        if (derived) {
          autoNamedSessions.current.add(sessionId);
          updateSessionLabel(sessionId, derived).catch((err) =>
            console.warn(`[SessionContext] auto-name failed for ${sessionId}:`, err),
          );
        }
      }
    }

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
      // Bug D fix: drop the queued flag whether the respawn succeeded or
      // failed.  If we kept it on failure, every subsequent submit would
      // re-trigger another fork-respawn with the same broken flag — no
      // back-off, no surrender — silently tearing down the bridge again
      // each time the user typed.  One attempt per chip-click is the
      // contract; the user can re-click if they really want a retry.
      if (queued) pendingFlags.current.delete(sessionId);
      if (!ok) {
        console.warn(
          `[SessionContext] respawnAgent failed for ${sessionId};` +
          ` dropped queued flags=${JSON.stringify(queued)} to avoid retry-loop`,
        );
      }
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

  // Once loaded, and whenever a session opens or closes, the saved workspace
  // is rewritten right away, not on the next 10 s tick, so a quit or crash
  // right after neither loses a session nor brings a closed one back.
  useSaveWorkspaceOnChange(Object.keys(state.sessions), workspaceReady, saveWorkspace);
  // Once a session exists in this run, the workspace saved before the launch
  // is replaced by what the user has now, even when that is nothing.
  const hasLiveSession = Object.values(state.sessions).some((s) => s.phase !== "destroyed");
  useEffect(() => {
    if (workspaceReady && hasLiveSession) keepSavedWorkspace = false;
  });
  // Every quit the backend can hold waits for this write first.
  useWorkspaceFlushOnQuit(saveWorkspace);
  // Test builds only: a scenario starts a terminal agent with a launch choice.
  useEffect(() => {
    if (import.meta.env.VITE_HERMES_E2E !== "1") return;
    setE2ESessionBridge({
      createSession: (opts) => createSession(opts),
      show: (id) => {
        const layout = stateRef.current.layout;
        if (!layout.root) dispatch({ type: "INIT_PANE", sessionId: id });
        else if (layout.focusedPaneId) dispatch({ type: "SET_PANE_SESSION", paneId: layout.focusedPaneId, sessionId: id });
      },
    });
    return () => setE2ESessionBridge(null);
  }, [createSession]);

  return (
    <SessionContext.Provider value={{ state, dispatch, createSession, closeSession, requestCloseSession, setActive, saveWorkspace, convertSessionMode, switchAgentModel, switchAgentPermissionMode, switchAgentEffort, submitAgentMessage, sendAgentEnvelope, respawnAgent: (sessionId) => respawnAgent(sessionId, {}) }}>
      {children}
      {pendingDirtyClose && (
        <Suspense fallback={null}>
        <DirtyWorktreeDialog
          sessionId={pendingDirtyClose.sessionId}
          sessionLabel={pendingDirtyClose.label}
          changes={pendingDirtyClose.changes}
          stashErrors={pendingDirtyClose.stashErrors}
          variant={isFeatureFlagEnabled("honestIsolation") ? "commit" : "stash"}
          agentWorking={pendingDirtyClose.agentWorking}
          closed={pendingDirtyClose.closed}
          keptPaths={pendingDirtyClose.kept}
          hookRefusal={pendingDirtyClose.hookRefusal ?? null}
          onStashAndClose={handleDirtyStashAndClose}
          onCommitAndClose={handleDirtyCommitAndClose}
          onArchiveAndClose={handleDirtyArchiveAndClose}
          onSaveDetachedAndClose={handleDirtySaveDetachedAndClose}
          onKeepAndClose={handleDirtyKeepAndClose}
          onCloseAnyway={handleDirtyCloseAnyway}
          onCancel={handleDirtyCancelClose}
        />
        </Suspense>
      )}
      {pendingBranchConflict && (
        <Suspense fallback={null}>
        <BranchConflictDialog
          key={`${pendingBranchConflict.conflict.projectId}:${pendingBranchConflict.conflict.branch}`}
          branchName={pendingBranchConflict.conflict.branch}
          heldBy={pendingBranchConflict.heldBy}
          path={pendingBranchConflict.conflict.path}
          localBranches={pendingBranchConflict.localBranches}
          onUseExisting={(name) => {
            setPendingBranchConflict(null);
            pendingBranchConflict.resolve({ kind: "existing-branch", name });
          }}
          onReuse={() => {
            setPendingBranchConflict(null);
            pendingBranchConflict.resolve({ kind: "reuse" });
          }}
          onCreateNewBranch={(name) => {
            setPendingBranchConflict(null);
            pendingBranchConflict.resolve({ kind: "new-branch", name });
          }}
          onRemoveLeftover={pendingBranchConflict.conflict.leftover ? () => {
            setPendingBranchConflict(null);
            pendingBranchConflict.resolve({ kind: "remove-leftover" });
          } : undefined}
          onCancel={() => {
            setPendingBranchConflict(null);
            pendingBranchConflict.resolve({ kind: "cancel" });
          }}
        />
        </Suspense>
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
 * named groups (alphabetically) → ungrouped, with destroyed sessions last
 * within each group and a handed-off session right under the one it came
 * from. ⌘1–9, the palette's ⌘1–9 labels and the sidebar all use this order.
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
    nestUnderParents(
      [...list].sort((a, b) => {
        const aD = a.phase === "destroyed" ? 1 : 0;
        const bD = b.phase === "destroyed" ? 1 : 0;
        return aD - bD;
      }),
    );
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

