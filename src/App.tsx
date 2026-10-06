import { useState, useEffect, useCallback, useRef, useMemo, Suspense } from "react";
import { lazyView } from "./utils/lazyView";
import React from "react";
import ReactDOM from "react-dom";
import { PluginRuntime } from "./plugins/PluginRuntime";
import { PluginLoader } from "./plugins/PluginLoader";
import { builtinPlugins } from "./plugins/builtin";
import { usePluginRuntime } from "./plugins/usePluginRuntime";
import { PluginPanelHost } from "./plugins/PluginPanelHost";
import { I18nProvider, useI18n } from "./i18n/I18nProvider";

// Expose React and ReactDOM as globals for dynamically loaded plugins.
// Plugins are IIFE bundles that externalize React and reference window.React.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).React = React;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ReactDOM = ReactDOM;
import "./styles/layout.css";
import "./styles/themes.css";
import "./styles/topbar.css";
import "./styles/onDemandViewStyles";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { fmt, isMac, PLATFORM } from "./utils/platform";
import { matchAppShortcut } from "./utils/shortcuts";
import { shortcutLabel } from "./utils/keymap";
import { installAppChordListener } from "./hooks/appChordListener";
import { isMenuGated, triggerMenuBarActionFromKeyboard } from "./hooks/nativeMenuBridge";
import { createProject } from "./api/projects";
import { SessionProvider, useSession, useActiveSession, useSessionList, useSidebarOrderedSessions } from "./state/SessionContext";
import { workingSessionIds } from "./state/tileLayout";
import { getSessionEventSnapshot } from "./agent/contract/sessionEventStore";
import { lastReportedStatus } from "./agent/status/deriveStatus";
import { isFeatureFlagEnabled } from "./featureFlags";
import { getSetting } from "./api/settings";
import { workingDirectoryRecoveryMessage, reusedCheckoutMessage, type WorkingDirectoryRecovery, type ReusedCheckout } from "./state/isolation";
import { SessionList } from "./components/SessionList";
import { hideOpeningOverlay, showOpeningOverlay } from "./utils/sessionCreatorOverlay";
import { ActivityBar, SessionsIcon, ContextIcon, UsageIcon, WorkbenchIcon, PlusIcon, PluginsIcon, SettingsIcon, TrackIcon, LibraryIcon } from "./components/ActivityBar";
import { useTrackWatching } from "./track/useTrackWatching";
import { attachedSessions, editorCommandFor, gateMovedLine, isAgentSession, submitLineBytes } from "./track/rules";
import { getTrackState, hasTurnHistory, noteOwnApproval } from "./track/store";
import { trackApprove } from "./track/api";
import { slugFromBranch } from "./track/rules";
import { writeToSession } from "./api/sessions";
import { utf8ToBase64 } from "./utils/encoding";
import { workbenchPixelWidth } from "./utils/workbenchLayout";
import { DEFAULT_SIDEBAR_WIDTH_PX, DEFAULT_SIDE_PANEL_WIDTH_PX, fitLeftRail, leftRailVisibility, leftRailWidth, resizeSidebar, resizeSidePanel } from "./utils/pluginPanelLayout";
import type { SessionView } from "./components/SessionList";

import { StatusBar } from "./components/StatusBar";
import { EmptyState } from "./components/EmptyState";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { LandSheetHost } from "./land/LandSheetHost";
import { QuitWithAgentsDialog, type WorkingSession } from "./components/QuitWithAgentsDialog";
import { DialogGalleryHost } from "./e2e/DialogGalleryHost";
import { sessionHostQuit, sessionHostSetQueued } from "./api/sessions";
import { FlowToast } from "./components/FlowToast";
import { copyContextToClipboard } from "./utils/copyContextToClipboard";
import { ProjectPicker } from "./components/ProjectPicker";
import { getComposerTextarea } from "./components/composerTextarea";
import { SplitLayout } from "./components/SplitLayout";
import { focusedPaneSnapshot, splitAfterCreateActions } from "./state/splitAfterCreate";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { setSetting } from "./api/settings";
import { SplitDirection, collectPanes } from "./state/layoutTypes";
import { getDraggedSession } from "./components/SplitPane";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { focusTerminal, getTerminal, refitActive } from "./terminal/TerminalPool";
import { useNativeMenuEvents } from "./hooks/useNativeMenuEvents";
import { useMenuStateSync } from "./hooks/useMenuStateSync";
import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { useBusyAgentSessionCount } from "./agent/useBusyAgentSessionCount";
import { useSessionProviders } from "./agent/providers/useSessionProviders";
import { isAgentStatusEnabled } from "./agent/status/flag";
import { usePluginUpdateChecker } from "./hooks/usePluginUpdateChecker";
import { useSessionGitSummary } from "./hooks/useSessionGitSummary";
import { hasAgentSession, useAgentBridgeWarmup } from "./hooks/useAgentBridgeWarmup";
import { listen } from "@tauri-apps/api/event";
import { UpdateDialog } from "./components/UpdateDialog";
import { PluginUpdateBanner } from "./components/PluginUpdateBanner";
import { ToastContainer } from "./components/ToastContainer";
import { WorktreeRecipePanel } from "./components/WorktreeRecipePanel";
import { useToastStore } from "./hooks/useToastStore";
import { useWorktreeErrorToasts } from "./hooks/useWorktreeErrorToasts";
import { useSessionNoticeToasts } from "./hooks/useSessionNoticeToasts";
import { PluginUpdateConfirmDialog } from "./components/PluginUpdateConfirmDialog";
import { launchFailedMessage } from "./catalog/agentCatalog";
import { OnboardingGate } from "./components/OnboardingGate";
import { agentDisplayName, getAgent } from "./catalog/agentCatalog";
import { getProjectsOrdered, getSessionProjects } from "./api/projects";
import { getSessionWorktreeInfo } from "./api/git";
import { probeTaskRepo, taskTrackPrompt, writeTaskDoneWhen, writeTaskFeatureFile } from "./api/launcher";
import { finishQueuedLaunch, handleUndeliveredTask, launchTask, normalizeRepoPath, type LaunchTaskDeps, type UndeliveredTask } from "./launcher/launchTask";
import { TASK_LAUNCHES_KEY } from "./launcher/taskLauncher";
import { LauncherReopen } from "./launcher/launcherReopen";
import type { TaskLaunchRequest, TaskLaunchResult } from "./components/TaskLauncher";
import { WhatsNewGate } from "./components/WhatsNewGate";
import { ContainedErrorBoundary } from "./components/ContainedErrorBoundary";
import { PanelResizeHandle } from "./components/PanelResizeHandle";
import { useFleetControls } from "./fleet/useFleetControls";
import { TASK_QUEUE_KEY, getOccupancy, listQueuedTasks, restoreTaskQueue, serializeTaskQueue, startTaskNow, subscribeTaskQueue, type QueuedTask } from "./fleet/taskQueue";
import { useOverlay } from "./state/overlays";
import { useWorktreeStorageNotices } from "./hooks/useWorktreeStorageNotices";
import type { CreateSessionOpts } from "./types/session";

// Loaded on demand, off the startup path: the editor (CodeMirror) with the
// file preview, Settings (with the plugin manager), and the Agent view —
// its composer and right-rail workbench only exist for Agent-mode sessions.
const Settings = lazyView("Settings", () => import("./components/Settings").then((m) => m.Settings));
const FilePreviewPanel = lazyView("FilePreviewPanel", () => import("./components/FilePreviewPanel").then((m) => m.FilePreviewPanel));
const SessionComposer = lazyView("SessionComposer", () => import("./components/SessionComposer").then((m) => m.SessionComposer));
const WorkbenchPanel = lazyView("WorkbenchPanel", () => import("./components/WorkbenchPanel").then((m) => m.WorkbenchPanel));
const TrackPanel = lazyView("TrackPanel", () => import("./components/TrackPanel").then((m) => m.TrackPanel));
// Side panels and the command palette: fetched the first time they open.
const ContextPanel = lazyView("ContextPanel", () => import("./components/ContextPanel").then((m) => m.ContextPanel));
const UsagePanel = lazyView("UsagePanel", () => import("./components/UsagePanel").then((m) => m.UsagePanel));
const ProcessPanel = lazyView("ProcessPanel", () => import("./components/ProcessPanel").then((m) => m.ProcessPanel));
const FileExplorerPanel = lazyView("FileExplorerPanel", () => import("./components/FileExplorerPanel").then((m) => m.FileExplorerPanel));
const SearchPanel = lazyView("SearchPanel", () => import("./components/SearchPanel").then((m) => m.SearchPanel));
const CommandPalette = lazyView("CommandPalette", () => import("./components/CommandPalette").then((m) => m.CommandPalette));
// 2.0 attention inbox (F12), behind the `attentionInbox` feature flag.
const AttentionCenter = lazyView("AttentionCenter", () => import("./components/AttentionCenter").then((m) => m.AttentionCenter));
const SessionGitPanel = lazyView("SessionGitPanel", () => import("./components/SessionGitPanel").then((m) => m.SessionGitPanel));
// F21: behind the reviewDesk flag, ⌘G opens the Review Desk and the git
// panels above are no longer reachable.
const ReviewDesk = lazyView("ReviewDesk", () => import("./components/ReviewDesk").then((m) => m.ReviewDesk));
// Dialogs that only exist once the user opens them.
const SessionCreator = lazyView("SessionCreator", () => import("./components/SessionCreator").then((m) => m.SessionCreator));
const TaskLauncher = lazyView("TaskLauncher", () => import("./components/TaskLauncher").then((m) => m.TaskLauncher));
// Prompts (⌘J): the one palette for finding a prompt and putting it to work.
const SessionPrompts = lazyView("SessionPrompts", () => import("./components/library/SessionPrompts").then((m) => m.SessionPrompts));
const ShortcutsPanel = lazyView("ShortcutsPanel", () => import("./components/ShortcutsPanel").then((m) => m.ShortcutsPanel));
const WorkspacePanel = lazyView("WorkspacePanel", () => import("./components/WorkspacePanel").then((m) => m.WorkspacePanel));
const CostDashboard = lazyView("CostDashboard", () => import("./components/CostDashboard").then((m) => m.CostDashboard));
// The prompt library: its code, catalog and strings load the first time it opens.
const LibraryView = lazyView("LibraryView", () => import("./components/library/LibraryView").then((m) => m.LibraryView));

function AppContent() {
  const { t } = useI18n();
  const { state, dispatch, createSession, closeSession, requestCloseSession, setActive, saveWorkspace } = useSession();
  const activeSession = useActiveSession();
  const sessions = useSessionList();
  // Feature Tracks (F28): every local session is attached to the watcher of
  // its worktree; the Track panel and the inbox read from the store.
  const featureTracksOn = isFeatureFlagEnabled("featureTracks");
  useTrackWatching(sessions, featureTracksOn);
  useAgentBridgeWarmup(sessions);
  const sidebarSessions = useSidebarOrderedSessions();
  const { ui } = state;
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [costDashboardOpen, setCostDashboardOpenState] = useState(false);
  // 2.0 fleet controls (flag, read once at startup). With it on, only the
  // spend an agent reports itself is shown, so the dashboard of estimated
  // costs does not open.
  const fleetOn = isFeatureFlagEnabled("fleetControls");
  const setCostDashboardOpen = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) => {
      if (!fleetOn) setCostDashboardOpenState(v);
    },
    [fleetOn],
  );
  // F21 Review Desk: replaces the git panels when its flag is on.
  const reviewDeskEnabled = isFeatureFlagEnabled("reviewDesk");
  const [reviewDeskOpen, setReviewDeskOpen] = useState(false);
  const toggleReviewDesk = useCallback(() => setReviewDeskOpen((open) => !open), []);
  // The old git panel's persisted "open" means nothing while the desk
  // replaces it: it must not keep the sidebar open or its button active.
  const gitPanelOpen = ui.gitPanelOpen && !reviewDeskEnabled;
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [sessionCreatorOpen, setSessionCreatorOpenInner] = useState<false | { group?: string }>(false);

  /** Wraps setSessionCreatorOpenInner so every entry point that opens
   *  the modal also synchronously injects the imperative "opening…"
   *  overlay into document.body BEFORE any React work happens (M11.2).
   *  React-based overlays raced strict-mode double-mount and lost the
   *  paint window; the imperative DOM call cannot be batched away. */
  const setSessionCreatorOpen = useCallback(
    (next: false | { group?: string }) => {
      if (next === false) {
        console.log("[opening-overlay] wrapper: close");
        void hideOpeningOverlay();
        setSessionCreatorOpenInner(false);
      } else {
        console.log(`[opening-overlay] wrapper: open at ${performance.now().toFixed(0)}ms — calling showOpeningOverlay()`);
        // 1. Inject overlay synchronously into document.body.
        showOpeningOverlay();
        // 2. Defer the modal mount until after the browser has had at
        //    least two animation-frame ticks, so the overlay actually
        //    paints alone before SessionCreator's heavy first mount
        //    pre-empts the next frame.  This is what makes Cmd+N work
        //    (OS menu provides natural paint interruptions) and the
        //    button NOT work — both paths now get the same explicit
        //    paint window.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            console.log(`[opening-overlay] rAF×2 tick at ${performance.now().toFixed(0)}ms — setting state to mount modal`);
            setSessionCreatorOpenInner(next);
          });
        });
      }
    },
    [],
  );
  // Task launcher (F15, flag taskLauncher): ⌘N opens it; the creator above
  // stays at ⌘⇧N for SSH, tmux and existing branches.
  // `gen` names the sheet: a new one (fresh state) mounts when it changes.
  const [taskLauncherOpen, setTaskLauncherOpen] = useState<false | { repo: string | null; gen: number; focus?: number }>(false);
  const taskLauncherOpenRef = useRef(taskLauncherOpen);
  taskLauncherOpenRef.current = taskLauncherOpen;
  const launcherGenRef = useRef(0);
  // Where the launcher waits to come back (see openSettings below).
  const launcherReturnRef = useRef<null | { kind: "settings" } | { kind: "sign-in"; sessionId: string | null }>(null);
  const [launcherReopen] = useState(() => new LauncherReopen());
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // "Open in Library" from Prompts (src/library/libraryFocus.ts says which entry).
  useEffect(() => {
    const show = () => setLibraryOpen(true);
    window.addEventListener("hermes:open-library", show);
    return () => window.removeEventListener("hermes:open-library", show);
  }, []);
  const [cmdPaletteShortcut, setCmdPaletteShortcut] = useState("cmd_k");
  const pendingSplit = useRef<{ paneId: string; direction: SplitDirection } | null>(null);
  // An update must never kill a working agent (N10): count agent sessions
  // mid-turn plus terminal sessions running a command, and have the
  // updater wait for all of them to go idle before it installs.
  const busyAgentSessionCount = useBusyAgentSessionCount();
  const busyTerminalSessionCount = useMemo(
    () => sessions.filter((s) => s.mode === "terminal" && s.phase === "busy").length,
    [sessions],
  );
  const updater = useAutoUpdater(busyAgentSessionCount + busyTerminalSessionCount);
  // F10/F19: every session reports into the one event store; the sidebar
  // and the status strip show the status derived from it.
  useSessionProviders(sessions, state.activeSessionId, isAgentStatusEnabled());
  const activeGitSummary = useSessionGitSummary(state.activeSessionId, !!activeSession, activeSession?.working_directory);

  // Load command palette shortcut setting (reload when settings panel closes)
  useEffect(() => {
    getSetting("command_palette_shortcut")
      .then((v) => { if (v) setCmdPaletteShortcut(v); })
      .catch(() => {});
  }, [settingsOpen]);

  // Load activity bar tab order
  useEffect(() => {
    getSetting("activity_bar_order")
      .then((v) => { if (v) { try { setActivityBarOrder(JSON.parse(v)); } catch {} } })
      .catch(() => {});
  }, []);

  // Keep a ref to state so plugin callbacks always read fresh values
  const stateRef = useRef(state);
  stateRef.current = state;

  // ── Plugin System ──
  const [activePluginPanel, setActivePluginPanel] = useState<string | null>(null);
  const [activeBottomPanel, setActiveBottomPanel] = useState<string | null>(null);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(300);
  const [activityBarOrder, setActivityBarOrder] = useState<string[]>([]);
  const [leftPanelWidth, setLeftPanelWidth] = useState(DEFAULT_SIDEBAR_WIDTH_PX);
  const [sidePanelWidth, setSidePanelWidth] = useState(DEFAULT_SIDE_PANEL_WIDTH_PX);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);

  // Right-rail Workbench width tracks the viewport, since its persisted
  // size is a *ratio* of the chat+workbench area (so a workspace saved
  // on a 27" display doesn't open with the chat squashed to nothing on
  // a 13" laptop).  The "available" budget is the viewport MINUS the
  // sidebar columns and both activity bars — i.e. the space that the
  // chat and workbench actually share.  Without this subtraction the
  // workbench would steal pixels from itself when the user opened the
  // sessions sidebar, and the "50/50" default felt closer to 25/75.
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const toastStore = useToastStore();
  const toastStoreRef = useRef(toastStore);
  toastStoreRef.current = toastStore;

  // Widths actually rendered after fitting the left rail to the window
  // (set below).  Drags start from these so a handle moves immediately
  // even when the stored width is wider than the window allows.
  const fittedLeftRailRef = useRef({ sidebarWidth: DEFAULT_SIDEBAR_WIDTH_PX, sidePanelWidth: DEFAULT_SIDE_PANEL_WIDTH_PX });
  const handleLeftResize = useCallback((delta: number) => {
    setLeftPanelWidth((w) => resizeSidebar(Math.min(w, fittedLeftRailRef.current.sidebarWidth), delta));
  }, []);
  const handleSidePanelResize = useCallback((delta: number) => {
    setSidePanelWidth((w) => resizeSidePanel(Math.min(w, fittedLeftRailRef.current.sidePanelWidth), delta));
  }, []);
  const handleRightResize = useCallback((delta: number) => {
    setRightPanelWidth((w) => Math.max(220, Math.min(500, w - delta)));
  }, []);
  const handleBottomResize = useCallback((delta: number) => {
    setBottomPanelHeight((h) => Math.max(120, Math.min(window.innerHeight * 0.8, h - delta)));
  }, []);

  // ── Worktree cleanup notification (R5.5) ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<number>("worktree-cleanup-summary", (event) => {
      if (cancelled) return;
      const count = event.payload;
      if (count > 0) {
        toastStoreRef.current.addToast({
          message: `Cleaned up ${count} stale worktree${count !== 1 ? "s" : ""} on startup`,
          type: "info",
          duration: 5000,
        });
      }
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── Missing worktree paths notification ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; branchName: string }[]>("worktree-paths-missing", (event) => {
      if (cancelled) return;
      const items = event.payload;
      if (items.length > 0) {
        const branches = items.map((i) => i.branchName).join(", ");
        toastStoreRef.current.addToast({
          message: `${items.length} worktree path${items.length !== 1 ? "s" : ""} missing on disk (${branches}). DB records cleaned up.`,
          type: "warning",
          duration: 8000,
        });
      }
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── Worktree cleanup failure notification ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; branchName: string; error: string }>("worktree-cleanup-failed", (event) => {
      if (cancelled) return;
      const { branchName, error } = event.payload;
      // Kept on purpose (a submodule's commits exist only there): say so
      // as the backend did, and leave the notice up.
      const kept = /Kept the worktree at /.test(error ?? "");
      toastStoreRef.current.addToast({
        message: kept ? error : `Failed to clean up branch worktree '${branchName}'. It will be retried on next startup.`,
        type: "warning",
        duration: kept ? null : 8000,
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── A session's folder was missing: where it opened instead ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<WorkingDirectoryRecovery>("session-working-directory-recovered", (event) => {
      if (cancelled) return;
      toastStoreRef.current.addToast({
        message: workingDirectoryRecoveryMessage(event.payload),
        type: event.payload.outcome === "recreated" ? "info" : "warning",
        duration: 15000,
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    const onRestoreFailed = (e: Event) => {
      const { id, label, error } = (e as CustomEvent<{ id: string; label: string; error: string }>).detail;
      toastStoreRef.current.addToast({
        message: `Could not restore session '${label}': ${error}. It will be tried again next time Hermes starts.`,
        type: "error",
        duration: 20000,
        actions: [{
          label: "Forget it",
          onClick: () => window.dispatchEvent(new CustomEvent("hermes:session-restore-forget", { detail: { id } })),
        }],
      });
    };
    window.addEventListener("hermes:session-restore-failed", onRestoreFailed);
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener("hermes:session-restore-failed", onRestoreFailed);
    };
  }, []);

  // ── Worktree path deleted externally (file watcher) ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; projectId: string; worktreePath: string; branchName: string }>("worktree-path-deleted", (event) => {
      if (cancelled) return;
      const { branchName } = event.payload;
      toastStoreRef.current.addToast({
        message: `Working directory for branch '${branchName}' was deleted externally`,
        type: "warning",
        duration: 8000,
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── AI launch failure notification ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("ai-launch-failed", (event) => {
      if (cancelled) return;
      toastStoreRef.current.addToast({
        message: launchFailedMessage(event.payload),
        type: "warning",
        duration: 15000,
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── An agent launch Hermes held back (folder it cannot open, person typing) ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ sessionId: string; message: string }>("agent-launch-blocked", (event) => {
      if (cancelled) return;
      toastStoreRef.current.addToast({ message: event.payload.message, type: "warning", duration: 30000 });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── A launcher task the agent's launch could not carry (F15) ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<UndeliveredTask>("task-prompt-undelivered", (event) => {
      if (cancelled) return;
      void handleUndeliveredTask(event.payload, {
        copyText: (text) => navigator.clipboard.writeText(text),
        notify: (message) => toastStoreRef.current.addToast({ message, type: "warning", duration: 15000 }),
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── Reused checkout notice (shared with a session, project folder, or outside Hermes) ──
  useEffect(() => {
    const handler = (e: Event) => {
      const { reused } = (e as CustomEvent).detail as { reused: ReusedCheckout[]; sessionLabel: string };
      for (const r of reused) {
        toastStoreRef.current.addToast({
          message: reusedCheckoutMessage(r),
          type: r.holder === "outside" ? "info" : "warning",
          duration: 10000,
        });
      }
    };
    window.addEventListener("hermes:shared-worktree", handler);
    return () => window.removeEventListener("hermes:shared-worktree", handler);
  }, []);

  // ── Worktree creation failures (#286) ──
  useWorktreeErrorToasts(toastStore.addToast);

  // ── Sessions that ended on their own, worktrees kept on close ──
  useSessionNoticeToasts(toastStore.addToast, {
    // Same id: its worktree link and terminal output stay; a new program starts.
    restart: (ids) => {
      for (const id of ids) {
        const s = state.sessions[id];
        if (!s) continue;
        void createSession({
          sessionId: id,
          label: s.label,
          workingDirectory: s.working_directory || undefined,
          color: s.color || undefined,
          group: s.group ?? undefined,
          aiProvider: s.ai_provider ?? undefined,
        });
      }
    },
    close: (ids) => {
      for (const id of ids) void requestCloseSession(id);
    },
  });

  const pluginRuntimeRef = useRef<PluginRuntime | null>(null);

  const [pluginRuntime] = useState<PluginRuntime>(() => {
    const runtime = new PluginRuntime({
      onPanelToggle: (panelId) => setActivePluginPanel(prev => prev === panelId ? null : panelId),
      onPanelShow: (panelId) => {
        setActivePluginPanel(panelId);
        dispatch({ type: "SET_SUBVIEW_PANEL", panel: null });
      },
      onPanelHide: () => setActivePluginPanel(null),
      onToast: (message, type, duration) => {
        toastStoreRef.current.addToast({ message, type: type as "info" | "success" | "warning" | "error", duration: duration ?? 3000 });
      },
      onStatusBarUpdate: (itemId, update) => {
        pluginRuntimeRef.current?.updateStatusBarItem(itemId, update);
      },
      onSessionActionBadgeUpdate: (actionId, badge) => {
        pluginRuntimeRef.current?.updateSessionActionBadge(actionId, badge);
      },
      onNotification: async (options) => {
        try {
          const { sendNotification } = await import("@tauri-apps/plugin-notification");
          await sendNotification(options);
        } catch {
          toastStoreRef.current.addToast({ message: options.title + (options.body ? `: ${options.body}` : ""), type: "info", duration: 3000 });
        }
      },
      onSessionsGetActive: async () => {
        const s = stateRef.current;
        const id = s.activeSessionId;
        if (!id || !s.sessions[id]) return null;
        const sess = s.sessions[id];
        return {
          id,
          name: sess.label,
          phase: sess.phase ?? "unknown",
          detected_agent: sess.detected_agent?.name ?? "unknown",
          working_directory: sess.working_directory ?? "",
          ai_provider: sess.ai_provider ?? undefined,
          created_at: sess.created_at ? new Date(sess.created_at).getTime() : undefined,
        };
      },
      onSessionsList: async () => {
        const s = stateRef.current;
        return Object.entries(s.sessions).map(([id, sess]) => ({
          id,
          name: sess.label,
          phase: sess.phase ?? "unknown",
          detected_agent: sess.detected_agent?.name ?? "unknown",
          working_directory: sess.working_directory ?? "",
          ai_provider: sess.ai_provider ?? undefined,
          created_at: sess.created_at ? new Date(sess.created_at).getTime() : undefined,
        }));
      },
      onSessionFocus: (sessionId: string) => {
        setActive(sessionId);
      },
      onSessionWorkingDirectory: (sessionId: string) => stateRef.current.sessions[sessionId]?.working_directory ?? null,
    }, { pluginApiV2: isFeatureFlagEnabled("pluginApiV2") });
    pluginRuntimeRef.current = runtime;
    for (const plugin of builtinPlugins) {
      runtime.register(plugin, { builtin: true });
    }
    return runtime;
  });

  const { commands: pluginCommands, panels: pluginPanels, pluginsWithSettings, sessionActions: pluginSessionActions } = usePluginRuntime(pluginRuntime);

  // Left-rail visibility (mirrors the render conditions below).  Plugin
  // panels and the Git / Files sub-views use their own side-panel width.
  const { sessionListVisible, secondPanelOpen, sidePanelVisible, selfSizedPanelVisible } = leftRailVisibility({
    flowMode: ui.flowMode,
    sessionListCollapsed: ui.sessionListCollapsed,
    gitPanelOpen: ui.gitPanelOpen,
    fileExplorerOpen: ui.fileExplorerOpen,
    searchPanelOpen: ui.searchPanelOpen,
    processPanelOpen: ui.processPanelOpen,
    hasActiveSession: !!state.activeSessionId,
    activePluginPanel,
    activePluginPanelIsLeft: pluginPanels.some(p => p.id === activePluginPanel && p.side === "left"),
  });
  const ACTIVITY_BAR_W = 36; // mirrors --activity-bar-w in tokens.css
  const leftRail = {
    activityBars: ui.flowMode ? 0 : ACTIVITY_BAR_W * 2,
    sessionListVisible,
    sidebarWidth: leftPanelWidth,
    sidePanelVisible,
    sidePanelWidth,
    selfSizedPanelVisible,
  };
  // Shrink the rail's columns when the window is too narrow for them,
  // so the chat area and the right activity bar are never pushed off.
  const fittedLeftRail = fitLeftRail(leftRail, viewportWidth);
  fittedLeftRailRef.current = fittedLeftRail;
  const sidebarBudget = leftRailWidth({ ...leftRail, ...fittedLeftRail });
  const chatWorkbenchSpace = Math.max(640, viewportWidth - sidebarBudget);
  const workbenchWidth = workbenchPixelWidth(chatWorkbenchSpace, ui.workbench.ratio);
  const pluginUpdater = usePluginUpdateChecker(pluginRuntime);
  const [pendingUpdatePlugins, setPendingUpdatePlugins] = useState<typeof pluginUpdater.updatesAvailable | null>(null);

  useEffect(() => {
    const loader = new PluginLoader(pluginRuntime, {
      // Fail closed, but never silently: say so when no plugin could load.
      onNotice: (message) => toastStoreRef.current.addToast({ message, type: "error", duration: null }),
    });
    // Load external plugins from disk, then activate all startup plugins
    // Expose CodeMirror core on window for language plugins
    import("./editor/codemirrorExports").then(m => m.exposeCodeMirror());
    loader.loadAllPlugins()
      .then(() => pluginRuntime.activateStartupPlugins())
      .catch(console.error);
  }, [pluginRuntime]);

  // ── Emit plugin events: window focus/blur ──
  useEffect(() => {
    const win = getCurrentWindow();
    let cancelled = false;
    let unlistenFn: (() => void) | null = null;
    win.onFocusChanged(({ payload: focused }) => {
      if (cancelled) return;
      pluginRuntime.emitEvent(focused ? "window.focused" : "window.blurred");
    }).then((u) => {
      if (cancelled) { u(); } else { unlistenFn = u; }
    });
    return () => { cancelled = true; unlistenFn?.(); };
  }, [pluginRuntime]);

  // ── Emit plugin events: session created/closed ──
  const prevSessionIds = useRef(new Set<string>());
  const prevSessionPhases = useRef(new Map<string, string>());
  useEffect(() => {
    const currentIds = new Set(Object.keys(state.sessions));
    for (const id of currentIds) {
      if (!prevSessionIds.current.has(id)) {
        pluginRuntime.emitEvent("session.created", id);
      }
    }
    for (const id of prevSessionIds.current) {
      if (!currentIds.has(id)) {
        pluginRuntime.emitEvent("session.closed", id);
      }
    }
    // Emit phase_changed events
    for (const [id, sess] of Object.entries(state.sessions)) {
      const prevPhase = prevSessionPhases.current.get(id);
      if (prevPhase !== undefined && prevPhase !== sess.phase) {
        pluginRuntime.emitEvent("session.phase_changed", {
          sessionId: id,
          previousPhase: prevPhase,
          newPhase: sess.phase,
        });
      }
      prevSessionPhases.current.set(id, sess.phase);
    }
    // Clean up phases for removed sessions
    for (const id of prevSessionIds.current) {
      if (!currentIds.has(id)) {
        prevSessionPhases.current.delete(id);
      }
    }
    prevSessionIds.current = currentIds;
  }, [state.sessions, pluginRuntime]);

  // ── Emit plugin events: session focus changed ──
  const prevActiveSessionId = useRef<string | null>(state.activeSessionId);
  useEffect(() => {
    if (prevActiveSessionId.current !== state.activeSessionId) {
      pluginRuntime.emitEvent("session.focus_changed", {
        sessionId: state.activeSessionId,
      });
      prevActiveSessionId.current = state.activeSessionId;
    }
  }, [state.activeSessionId, pluginRuntime]);

  // When a built-in panel opens, close plugin panels
  useEffect(() => {
    if (ui.gitPanelOpen || ui.processPanelOpen || ui.fileExplorerOpen || ui.searchPanelOpen) {
      setActivePluginPanel(null);
    }
  }, [ui.gitPanelOpen, ui.processPanelOpen, ui.fileExplorerOpen, ui.searchPanelOpen]);

  // Keyboard shortcuts — only those NOT handled by native menu bar. Keys are
  // matched only through src/shortcuts/app-shortcuts.json (matchAppShortcut),
  // the same list the Shortcuts panel and docs/shortcuts.md are generated
  // from, so every binding here is listed there and vice versa.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const action = matchAppShortcut(e);
      if (!action) return;
      // The unfinished first-run welcome owns the window (see setMenuGate).
      if (isMenuGated()) return;

      // Cmd+Shift+P — always toggles command palette (alternative shortcut)
      if (action === "app.command-palette-alt") {
        e.preventDefault();
        dispatch({ type: "TOGGLE_PALETTE" });
        return;
      }

      // Cmd+Alt+B (mac) / Ctrl+Alt+B (other) — toggle the right-rail
      // Workbench (1.1.14).  Only meaningful for agent-mode sessions;
      // for terminal sessions the workbench isn't mounted, so we noop
      // rather than swallow the keystroke.
      if (action === "app.toggle-workbench") {
        const sid = state.activeSessionId;
        const sess = sid ? state.sessions[sid] : null;
        if (sess?.mode === "agent") {
          e.preventDefault();
          dispatch({ type: "TOGGLE_WORKBENCH" });
        }
        return;
      }

      // Suppress session-switch shortcuts while any modal/overlay is open
      const anyOverlayOpen = ui.commandPaletteOpen || !!settingsOpen || ui.composerOpen || sessionCreatorOpen || taskLauncherOpen || shortcutsOpen || costDashboardOpen || workspaceOpen || projectPickerOpen;
      if (anyOverlayOpen) return;

      // Cmd+Shift+J — toggle focus between the active session's pane and
      // the agent composer.  Only meaningful for agent-mode sessions; in
      // terminal mode the composer is not mounted and this is a no-op.
      if (action === "app.focus-composer") {
        const sid = state.activeSessionId;
        if (!sid) return;
        const sess = state.sessions[sid];
        if (sess?.mode !== "agent") return;
        e.preventDefault();
        const ta = getComposerTextarea();
        if (ta && document.activeElement === ta) {
          // Already focused → blur to give the pane focus back.  Simple
          // blur is enough; the agent view doesn't have its own input.
          ta.blur();
        } else if (ta) {
          ta.focus();
        } else {
          // Composer is collapsed (no textarea mounted) — ask it to expand.
          window.dispatchEvent(new CustomEvent("hermes:expand-composer", { detail: { sessionId: sid } }));
        }
        return;
      }

      // Cmd+Alt+Arrow — pane navigation
      if (action === "app.focus-next-pane" || action === "app.focus-previous-pane") {
        if (!state.layout.root) return;
        const panes = collectPanes(state.layout.root);
        if (panes.length > 1) {
          e.preventDefault();
          const currentIdx = panes.findIndex((p) => p.id === state.layout.focusedPaneId);
          const nextIdx = action === "app.focus-next-pane"
            ? (currentIdx + 1) % panes.length
            : (currentIdx - 1 + panes.length) % panes.length;
          dispatch({ type: "FOCUS_PANE", paneId: panes[nextIdx].id });
        }
        return;
      }

      // Cmd+1-9 — session switch (matches sidebar visual order)
      if (action === "app.switch-session") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < sidebarSessions.length) setActive(sidebarSessions[idx].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.layout, sidebarSessions, dispatch, setActive, ui.commandPaletteOpen, settingsOpen, ui.composerOpen, sessionCreatorOpen, taskLauncherOpen, shortcutsOpen, costDashboardOpen, workspaceOpen, projectPickerOpen]);

  const handleReconnect = useCallback(async (session: import("./types/session").SessionData) => {
    if (!session.ssh_info) return;
    const { host, port, user, tmux_session, identity_file, jump_host } = session.ssh_info;
    const oldLabel = session.label;
    // Close the disconnected session first
    await closeSession(session.id);
    // Create a new session with the same SSH params
    await createSession({
      label: oldLabel,
      sshHost: host,
      sshPort: port,
      sshUser: user,
      tmuxSession: tmux_session ?? undefined,
      sshIdentityFile: identity_file ?? undefined,
      sshJumpHost: jump_host ?? undefined,
    });
  }, [closeSession, createSession]);

  // Re-focus the active terminal when the app window regains focus
  // (e.g. after a system dialog, Cmd+Tab, or notification steals focus).
  // Uses Tauri's onFocusChanged (reliable in WKWebView) + browser fallbacks.
  // Skips re-focus when any modal/overlay with input fields is open so it
  // doesn't steal focus from text inputs inside overlays.
  const activeSessionIdRef = useRef(activeSession?.id ?? null);
  activeSessionIdRef.current = activeSession?.id ?? null;
  const anyOverlayOpenRef = useRef(false);
  const [attentionInboxOpen, setAttentionInboxOpen] = useState(false);
  anyOverlayOpenRef.current = !!(ui.commandPaletteOpen || settingsOpen || ui.composerOpen || sessionCreatorOpen || taskLauncherOpen || shortcutsOpen || costDashboardOpen || workspaceOpen || projectPickerOpen || attentionInboxOpen);

  useEffect(() => {
    if (!activeSession) return;
    let cancelled = false;

    const safeFocus = () => {
      if (anyOverlayOpenRef.current) return;
      const id = activeSessionIdRef.current;
      if (id) focusTerminal(id);
    };

    // Tauri window focus event — most reliable in WKWebView
    let unlistenTauri: (() => void) | null = null;
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (cancelled) return;
      if (focused) safeFocus();
    }).then((u) => {
      if (cancelled) { u(); } else { unlistenTauri = u; }
    });

    // Browser fallbacks for edge cases
    const onFocus = () => safeFocus();
    const onVisibility = () => {
      if (document.visibilityState === "visible") safeFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      unlistenTauri?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeSession?.id]);

  // Global capture-phase window drag listener — bypasses React synthetic events,
  // WKWebView focus quirks, and Tauri's automatic injection.
  // startDragging() hands mouse control to the OS, swallowing all subsequent
  // events — so we only call it once the mouse actually moves after mousedown.
  // Double-click is detected via mouseup timing since WKWebView does not
  // reliably fire dblclick events on the overlay titlebar.
  useEffect(() => {
    const win = getCurrentWindow();
    const DRAG_THRESHOLD = 3; // px of movement before initiating drag
    const DOUBLE_CLICK_MS = 500;
    let pending: { x: number; y: number } | null = null;
    let dragged = false;
    let lastClickTime = 0;

    const isTopbarDragArea = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return false;
      if (!target.closest(".topbar")) return false;
      if (target.closest("button") || target.closest("input") || target.closest(".topbar-controls")) return false;
      return true;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!isTopbarDragArea(e)) return;
      pending = { x: e.clientX, y: e.clientY };
      dragged = false;
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!pending) return;
      const dx = e.clientX - pending.x;
      const dy = e.clientY - pending.y;
      if (dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD) {
        pending = null;
        dragged = true;
        win.startDragging().catch(() => {});
      }
    };
    const onMouseUp = (e: MouseEvent) => {
      pending = null;
      if (dragged) { dragged = false; return; }
      if (!isTopbarDragArea(e)) return;
      const now = Date.now();
      if (now - lastClickTime < DOUBLE_CLICK_MS) {
        lastClickTime = 0;
        win.toggleMaximize().catch(() => {});
      } else {
        lastClickTime = now;
      }
    };
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
    };
  }, []);

  // ── Global contextmenu suppression ──
  // Capture-phase listener prevents the browser context menu on ALL surfaces.
  // Components with custom menus call e.stopPropagation() to intercept first.
  useEffect(() => {
    const suppress = (e: Event) => { e.preventDefault(); };
    document.addEventListener("contextmenu", suppress, true);
    return () => document.removeEventListener("contextmenu", suppress, true);
  }, []);

  // ── Save workspace before app close ──
  // Closing the window is held by the backend until the workspace is written
  // (src-tauri/src/quit_flush.rs, answered by useWorkspaceFlushOnQuit). There
  // is deliberately no close-requested listener here: one would make Tauri
  // hold the close for this webview too and race the backend's hold.
  // beforeunload stays as a fire-and-forget fallback for a webview reload.
  const saveWorkspaceRef = useRef(saveWorkspace);
  saveWorkspaceRef.current = saveWorkspace;
  const workspaceSavedRef = useRef(false);

  // N20: quitting with a working agent asks "keep running or stop". The
  // backend holds the quit (the window's close button or an app quit) and
  // sends `session-host-quit-requested`; either answer goes back to the
  // backend, which acts on it and quits.
  const [quitAsk, setQuitAsk] = useState<WorkingSession[] | null>(null);
  const answerQuit = useCallback(async (keepRunning: boolean) => {
    setQuitAsk(null);
    workspaceSavedRef.current = true;
    try {
      await saveWorkspaceRef.current();
    } catch (err) {
      console.error("[App] Failed to save workspace before quit:", err);
    }
    try {
      await sessionHostQuit(keepRunning);
    } catch (err) {
      console.error("[App] session_host_quit failed:", err);
      workspaceSavedRef.current = false;
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ id: string; label: string; hosted?: boolean; detected_agent?: unknown; ai_provider?: string | null }[]>("session-host-quit-requested", (event) => {
      if (cancelled) return;
      // Whether each can keep running (hosted) and is an agent or a program.
      setQuitAsk(event.payload.map((s) => ({ id: s.id, label: s.label, hosted: s.hosted !== false, agent: !!(s.detected_agent || s.ai_provider) })));
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  // The flag is on but a terminal had to open in-process (the host could
  // not be reached): the user must know it will not survive a quit.
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; reason: string }>("session-host-fallback", (event) => {
      if (cancelled) return;
      toastStoreRef.current.addToast({
        message: t("sessionHost.fallback", { reason: event.payload.reason }),
        type: "warning",
        duration: 8000,
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [t]);

  useEffect(() => {
    const onBeforeUnload = () => {
      if (workspaceSavedRef.current) return;
      workspaceSavedRef.current = true;
      saveWorkspaceRef.current().catch(console.error);
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  // Tauri drag-drop for empty container (no panes) — session drop creates first pane
  const layoutRootRef = useRef(state.layout.root);
  layoutRootRef.current = state.layout.root;

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    let capturedSessionId: string | null = null;

    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      // Only handle when no panes exist — SplitPane handles drops when panes exist
      if (layoutRootRef.current) return;

      if (event.payload.type === "enter") {
        capturedSessionId = getDraggedSession();
      } else if (event.payload.type === "drop") {
        if (capturedSessionId) {
          dispatch({ type: "INIT_PANE", sessionId: capturedSessionId });
        }
        capturedSessionId = null;
      } else if (event.payload.type === "leave") {
        capturedSessionId = null;
      }
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); };
  }, [dispatch]);

  // ── Fleet controls: spend caps, Collision Radar, task queue ──
  const activeIdRef = useRef(state.activeSessionId);
  activeIdRef.current = state.activeSessionId;
  /** A queued task starts in the background: whatever the user is looking
   *  at stays in front. */
  // The launcher's launch steps (set below), for a launcher task that waited in the queue.
  const launchDepsRef = useRef<(() => LaunchTaskDeps) | null>(null);
  const startQueuedTask = useCallback(async (opts: CreateSessionOpts, task: QueuedTask) => {
    const before = activeIdRef.current;
    const session = await createSession(opts);
    if (session) {
      if (!layoutRootRef.current) dispatch({ type: "INIT_PANE", sessionId: session.id });
      else if (before) dispatch({ type: "SET_ACTIVE", id: before });
      // A task from the ⌘N launcher finishes its launch as one that started
      // at once: its feature.md, its checks, its record, its pairing.
      const deps = launchDepsRef.current?.();
      if (task.launch && deps) {
        void finishQueuedLaunch(task.launch, session.id, deps).catch((err) => console.warn("[App] a queued task's launch did not finish:", err));
      }
    }
    return session;
  }, [createSession, dispatch]);
  const fleet = useFleetControls({ enabled: fleetOn, sessions, startTask: startQueuedTask, t });
  // ── Task launcher (F15) ──
  const launcherOn = isFeatureFlagEnabled("taskLauncher");
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const layoutRef = useRef(state.layout);
  layoutRef.current = state.layout;

  /** Show a session the app just created: the focused pane (or the first pane) gets it. */
  const showSession = useCallback((sessionId: string) => {
    const layout = layoutRef.current;
    if (!layout.root) dispatch({ type: "INIT_PANE", sessionId });
    else if (layout.focusedPaneId) dispatch({ type: "SET_PANE_SESSION", paneId: layout.focusedPaneId, sessionId });
  }, [dispatch]);

  /**
   * ⌘N: the launcher, on the repository of the active session. `fresh`: a
   * new sheet even if one is open (after a launch that ⌘N came during).
   */
  const openTaskLauncher = useCallback(async (fresh = false) => {
    // The open sheet is finishing a launch and will close: it opens again then.
    if (!fresh && !launcherReopen.requestOpen(!!taskLauncherOpenRef.current)) return;
    // Opened again (⌘N, or the configuration it waited for closed): nothing waits any more.
    launcherReturnRef.current = null;
    // Already open: it keeps its state and takes the keyboard back.
    if (taskLauncherOpenRef.current && !fresh) {
      setTaskLauncherOpen((cur) => (cur ? { ...cur, focus: (cur.focus ?? 0) + 1 } : cur));
      return;
    }
    const s = activeSessionRef.current;
    let repo: string | null = null;
    // The active session's repository, when it is in one. A plain shell in
    // the home folder or a sign-in terminal is not a place to start a task:
    // the launcher then starts on the most used project.
    if (s && !s.ssh_info && !s.agent_launch?.login) {
      let candidate = s.working_directory;
      // A folder the session was opened on (git or not) is a place to start a task too.
      let project: string | null = null;
      try {
        project = (await getSessionProjects(s.id))[0]?.path ?? null;
        candidate = project ?? s.working_directory;
      } catch {
        // the session's own folder
      }
      try {
        const probe = candidate ? await probeTaskRepo(candidate) : null;
        repo = probe?.git_root ?? (project && probe?.is_dir ? project : null);
      } catch {
        repo = null;
      }
    }
    setTaskLauncherOpen((cur) => ({ repo, gen: cur && !fresh ? cur.gen : ++launcherGenRef.current }));
  }, [launcherReopen]);

  /**
   * Configuration opened from the launcher (Settings, Manage accounts, a
   * sign-in) takes its place; the launcher keeps its draft (TaskLauncher
   * saves it as it goes) and comes back exactly as it was when that
   * configuration closes: Settings closing, or the sign-in terminal ending.
   */
  const openSettings = useCallback((tab: string) => {
    if (taskLauncherOpenRef.current) {
      launcherReturnRef.current = { kind: "settings" };
      setTaskLauncherOpen(false);
    }
    setSettingsOpen(tab);
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(null);
    if (launcherReturnRef.current?.kind === "settings") void openTaskLauncher();
  }, [openTaskLauncher]);

  // Old worktrees filling the disk: low space, space freed, space held (Settings > Storage).
  useWorktreeStorageNotices(
    useCallback((toast) => toastStoreRef.current.addToast(toast), []),
    useCallback(() => openSettings("storage"), [openSettings]),
  );

  // One overlay at a time (state/overlays.ts): Settings, Keyboard Shortcuts,
  // the cost dashboard and the New Session wizard close when another overlay
  // opens, and opening one of them closes the others (the launcher keeps its
  // draft). Closed this way, Settings does not bring the launcher back.
  useOverlay("settings", !!settingsOpen, () => {
    launcherReturnRef.current = null;
    setSettingsOpen(null);
  });
  useOverlay("shortcuts", shortcutsOpen, () => setShortcutsOpen(false));
  useOverlay("cost", costDashboardOpen, () => setCostDashboardOpen(false));
  useOverlay("creator", !!sessionCreatorOpen, () => {
    setSessionCreatorOpen(false);
    pendingSplit.current = null;
  });

  // N22: tasks waiting in the queue are kept while Hermes is closed and come
  // back when it opens (setting task_queue), in their order.
  const [queuedCount, setQueuedCount] = useState(0);
  useEffect(() => {
    let restored = false;
    let cancelled = false;
    getSetting(TASK_QUEUE_KEY)
      .catch(() => "")
      .then((raw) => {
        if (cancelled) return;
        restoreTaskQueue(raw);
        restored = true;
        setQueuedCount(listQueuedTasks().length);
      });
    const off = subscribeTaskQueue(() => {
      const list = listQueuedTasks();
      setQueuedCount(list.length);
      // Not before the stored queue was read: writing first would lose it.
      if (restored) setSetting(TASK_QUEUE_KEY, serializeTaskQueue(list)).catch((err) => console.warn("[App] could not keep the task queue:", err));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  // The quit asks first when tasks wait in the queue, also with no agent at work.
  useEffect(() => {
    sessionHostSetQueued(queuedCount).catch(() => {});
  }, [queuedCount]);
  /** A sign-in from the launcher (or from Settings opened from it): the launcher waits for that terminal. */
  const launcherWaitsForSignIn = useCallback((): boolean => {
    const from = !!taskLauncherOpenRef.current || launcherReturnRef.current?.kind === "settings";
    if (from) launcherReturnRef.current = { kind: "sign-in", sessionId: null };
    setTaskLauncherOpen(false);
    return from;
  }, []);
  const signInStarted = useCallback((fromLauncher: boolean, sessionId: string | null) => {
    if (!fromLauncher || launcherReturnRef.current?.kind !== "sign-in") return;
    if (sessionId) launcherReturnRef.current = { kind: "sign-in", sessionId };
    else void openTaskLauncher();
  }, [openTaskLauncher]);
  useEffect(() => {
    const waiting = launcherReturnRef.current;
    if (waiting?.kind !== "sign-in" || !waiting.sessionId) return;
    const s = sessions.find((x) => x.id === waiting.sessionId);
    if (!s || s.phase === "destroyed") void openTaskLauncher();
  }, [sessions, openTaskLauncher]);

  /** The launcher sheet closed; a ⌘N pressed while it was launching opens a fresh one. */
  const onTaskLauncherClosed = useCallback(() => {
    const again = launcherReopen.closed();
    setTaskLauncherOpen(false);
    if (again) void openTaskLauncher(true);
  }, [launcherReopen, openTaskLauncher]);

  const openNewSession = useCallback(() => {
    if (launcherOn) void openTaskLauncher();
    else setSessionCreatorOpen({});
  }, [launcherOn, openTaskLauncher, setSessionCreatorOpen]);

  /** ⌘⇧N: the full creator. */
  const openAdvancedCreator = useCallback(() => {
    launcherReturnRef.current = null;
    setTaskLauncherOpen(false);
    setSessionCreatorOpen({});
  }, [setSessionCreatorOpen]);

  /** Sign in: the agent's own CLI in a terminal, where it asks the person to sign in. */
  const signInAgent = useCallback(async (agentId: string) => {
    const fromLauncher = launcherWaitsForSignIn();
    const session = await createSession({
      aiProvider: agentId,
      mode: "terminal",
      label: t("agentError.signInSessionLabel", { agent: getAgent(agentId)?.name ?? agentId }),
    });
    if (session) showSession(session.id);
    signInStarted(fromLauncher, session?.id ?? null);
  }, [createSession, showSession, t, launcherWaitsForSignIn, signInStarted]);

  /** 2.0: sign an account Hermes added in: the CLI's sign-in, in that account's profile. */
  const signInAccount = useCallback(async (agentId: string, accountId: string) => {
    const fromLauncher = launcherWaitsForSignIn();
    const session = await createSession({
      aiProvider: agentId,
      mode: "terminal",
      label: t("agentError.signInSessionLabel", { agent: getAgent(agentId)?.name ?? agentId }),
      agentLaunch: { accountId, purpose: "login" },
    });
    if (session) showSession(session.id);
    signInStarted(fromLauncher, session?.id ?? null);
  }, [createSession, showSession, t, launcherWaitsForSignIn, signInStarted]);

  /** What a launcher task's launch does to the app (launchTask's effects), for now or for when it leaves the queue. */
  const launchDeps = useCallback((): LaunchTaskDeps => ({
    projectFor: async (root) => {
      const want = normalizeRepoPath(root, PLATFORM === "win");
      const known = (await getProjectsOrdered()).find((p) => normalizeRepoPath(p.path, PLATFORM === "win") === want);
      return known ? known.id : (await createProject(root, null)).id;
    },
    createSession,
    // With a running-agents or memory cap and no free slot, the task
    // waits in the queue instead of starting (N22).
    queue: (opts, label, launch) => fleet.queueIfFull(opts, label, launch),
    place: (sessionId, index, firstSessionId) => {
      const paneId = layoutRef.current.focusedPaneId;
      if (index === 0 || !firstSessionId || !paneId) {
        showSession(sessionId);
        return;
      }
      // The same task on a second agent opens beside the first. Creating
      // it put it into the focused pane, so that pane gets the first back.
      for (const action of splitAfterCreateActions({ paneId, sessionId: firstSessionId }, { paneId, direction: "horizontal" }, sessionId)) {
        dispatch(action);
      }
    },
    // A linked worktree only: a session on the repository's own checkout has none.
    worktreePath: async (sessionId, projectId) => {
      const info = await getSessionWorktreeInfo(sessionId, projectId);
      return info && !info.isMainWorktree ? info.worktreePath : null;
    },
    writeFeatureFile: writeTaskFeatureFile,
    writeDoneWhen: writeTaskDoneWhen,
    trackPrompt: taskTrackPrompt,
    copyText: (text) => navigator.clipboard.writeText(text),
    readRecords: () => getSetting(TASK_LAUNCHES_KEY).catch(() => ""),
    writeRecords: (raw) => setSetting(TASK_LAUNCHES_KEY, raw),
    now: () => Date.now(),
    notify: (message) => toastStoreRef.current.addToast({ message, type: "error", duration: 10000 }),
  }), [createSession, dispatch, showSession, fleet]);
  launchDepsRef.current = launchDeps;

  const runTaskLaunch = useCallback(async (req: TaskLaunchRequest): Promise<TaskLaunchResult> => {
    const result = await launchTask(req, launchDeps());
    if (!result.ok) return false;
    if (result.sessionIds.length === 0 && result.queued > 0) {
      // Nothing started: said on screen (the queue may be out of view), with a way to start it anyway.
      const running = getOccupancy().sessionIds.length;
      toastStoreRef.current.addToast({
        message: running === 0 ? t("fleet.queuedToastSlot") : running === 1 ? t("fleet.queuedToastOne") : t("fleet.queuedToast", { count: running }),
        type: "info",
        duration: 8000,
        actions: [
          {
            label: t("fleet.queueStartNow"),
            primary: true,
            onClick: () => {
              for (const q of listQueuedTasks()) if (q.launch?.launchId === result.launchId) startTaskNow(q.id);
            },
          },
        ],
      });
      return "queued";
    }
    return true;
  }, [launchDeps, t]);

  /** A launch from the ⌘N sheet, which closes itself once it is done (unless it stays open). */
  const runSheetLaunch = useCallback(async (req: TaskLaunchRequest): Promise<TaskLaunchResult> => {
    if (!req.staysOpen) launcherReopen.launchStarted();
    let result: TaskLaunchResult = false;
    try {
      result = await runTaskLaunch(req);
      return result;
    } finally {
      if (!result) launcherReopen.launchFailed();
    }
  }, [launcherReopen, runTaskLaunch]);

  // ── Instant session creation (Cmd+N / Cmd+T) ──
  const createSessionDirect = useCallback(async () => {
    const session = await createSession({});
    if (session) {
      if (!state.layout.root) {
        dispatch({ type: "INIT_PANE", sessionId: session.id });
      } else if (state.layout.focusedPaneId) {
        dispatch({ type: "SET_PANE_SESSION", paneId: state.layout.focusedPaneId, sessionId: session.id });
      }
    }
  }, [createSession, state.layout.root, state.layout.focusedPaneId, dispatch]);

  // ── Feature Tracks (F28): the person's actions from the panel and the palette ──
  /** ⇧O in the Track panel: the file in $EDITOR, in a split next to this pane. */
  const openTrackFileInSplit = useCallback(async (path: string) => {
    if (!activeSession) return;
    const focusedBefore = focusedPaneSnapshot(state.layout);
    const session = await createSession({
      workingDirectory: activeSession.working_directory,
      aiProvider: "custom",
      agentName: "editor",
      agentCommand: editorCommandFor(activeSession.shell, path),
      mode: "terminal",
      label: `edit ${path.split(/[\\/]/).pop() ?? "file"}`,
    });
    if (!session) return;
    if (state.layout.root && state.layout.focusedPaneId) {
      for (const action of splitAfterCreateActions(focusedBefore, { paneId: state.layout.focusedPaneId, direction: "horizontal" }, session.id)) dispatch(action);
    } else if (!state.layout.root) {
      dispatch({ type: "INIT_PANE", sessionId: session.id });
    }
  }, [activeSession, createSession, state.layout, dispatch]);
  /** `r` in the Track panel: one tagged line to the writer's terminal. */
  // Submitted as Enter would: a bracketed paste for a program that asked for one (see submitLineBytes).
  const sendLineToSession = useCallback(
    (sessionId: string, line: string) => writeToSession(sessionId, utf8ToBase64(submitLineBytes(line, getTerminal(sessionId)?.modes.bracketedPasteMode ?? false))),
    [],
  );
  /** Palette: approve the active worktree's waiting gate. */
  const approveActiveGate = useCallback(async () => {
    if (!activeSession) return;
    const track = getTrackState(activeSession.working_directory);
    const feature = track.features.find((f) => f.slug === track.slug) ?? (track.features.length === 1 ? track.features[0] : undefined);
    if (!feature?.meta || feature.meta.gate !== "waiting") {
      toastStore.addToast({ message: t("track.noGateWaiting"), type: "info", duration: 3000 });
      return;
    }
    try {
      noteOwnApproval(activeSession.working_directory, feature.slug);
      const move = await trackApprove(activeSession.working_directory, feature.slug);
      // The agent stopped at the gate: tell it (as the Track panel does).
      const writer = attachedSessions(sessions, activeSession.working_directory, hasTurnHistory)[0];
      if (writer && isAgentSession(writer, hasTurnHistory)) await sendLineToSession(writer.id, gateMovedLine(feature.slug, move, "approved")).catch(() => {});
      toastStore.addToast({ message: t("track.approvedToast", { slug: feature.slug, from: move.from, to: move.to }), type: "success", duration: 4000 });
    } catch (e) {
      toastStore.addToast({ message: String(e), type: "error", duration: 5000 });
    }
  }, [activeSession, toastStore, t, sessions, sendLineToSession]);
  /** Palette: "Make it a feature" for the active worktree (Light track). */
  const makeActiveFeature = useCallback(async () => {
    if (!activeSession) return;
    const track = getTrackState(activeSession.working_directory);
    try {
      // An explicit palette command; its toast offers Undo like the Track panel.
      const { promoteWithUndo } = await import("./track/promote");
      await promoteWithUndo(activeSession.working_directory, slugFromBranch(track.branch, activeSession.working_directory), "Light", toastStore, t);
      if (!ui.trackPanelOpen) dispatch({ type: "TOGGLE_TRACK" });
    } catch (e) {
      toastStore.addToast({ message: String(e), type: "error", duration: 5000 });
    }
  }, [activeSession, toastStore, ui.trackPanelOpen, dispatch, t]);

  // Help > Check for Updates… and the version chip: always say how it went
  // (an update found opens its dialog).
  const { manualCheck } = updater;
  const checkForUpdatesNow = useCallback(async () => {
    const result = await manualCheck();
    if (result === "none") {
      toastStoreRef.current.addToast({ message: t("statusbar.update.upToDate", { version: __APP_VERSION__ }), type: "success", duration: 5000 });
    } else if (result === "error") {
      toastStoreRef.current.addToast({ message: t("statusbar.update.checkFailed"), type: "error", duration: 8000 });
    }
  }, [manualCheck, t]);

  // ── Native menu bar event bridge ──
  useNativeMenuEvents({
    dispatch,
    createSession: openNewSession,
    createSessionAdvanced: openAdvancedCreator,
    createSessionDirect,
    requestCloseSession,
    activeSessionId: state.activeSessionId,
    focusedPaneId: state.layout.focusedPaneId,
    setSettingsOpen: (tab) => (tab === null ? closeSettings() : openSettings(tab)),
    setShortcutsOpen,
    setCostDashboardOpen,
    setSessionCreatorOpen,
    copyContextToClipboard: () => copyContextToClipboard(activeSession),
    pendingSplit,
    onCheckForUpdates: () => void checkForUpdatesNow(),
    commandPaletteShortcut: cmdPaletteShortcut,
    toggleReviewDesk: reviewDeskEnabled ? toggleReviewDesk : undefined,
  });

  // ── Windows/Linux: app chords typed in the webview (terminal keeps Ctrl+letter) ──
  useEffect(() => installAppChordListener(window, PLATFORM, triggerMenuBarActionFromKeyboard), []);

  // ── Sync UI toggle state → native menu checkmarks ──
  useMenuStateSync({
    sidebarVisible: !ui.sessionListCollapsed,
    processPanelOpen: ui.processPanelOpen,
    // F21: with the desk on, the ⌘G item's checkmark follows the desk.
    gitPanelOpen: reviewDeskEnabled ? reviewDeskOpen : ui.gitPanelOpen,
    gitPanelLabel: reviewDeskEnabled ? t("palette.reviewDesk") : undefined,
    contextPanelOpen: ui.contextPanelOpen,
    searchPanelOpen: ui.searchPanelOpen,
    flowMode: ui.flowMode,
    costDashboardAvailable: !fleetOn,
  });

  // Attention inbox (F12): show a session's pane and give it the keyboard.
  // Never reorders the sidebar.
  const jumpToSession = useCallback((sessionId: string) => {
    if (!state.sessions[sessionId]) return;
    setActive(sessionId);
    requestAnimationFrame(() => focusTerminal(sessionId));
  }, [state.sessions, setActive]);

  return (
    <div className={`app ${ui.flowMode ? "flow-mode" : ""}`}>
      {/* Top bar */}
      <div className="topbar">
        {/* Traffic light spacer (macOS only — reserve space for native window controls) */}
        {isMac && <div className="topbar-traffic-spacer" />}

        {/* Center — decorative, pass-through for drag */}
        <div className="topbar-center">
          {activeSession ? (
            <>
              <span className="topbar-dot" style={{ background: activeSession.color }} />
              <span className="topbar-session-name">{activeSession.label}</span>
            </>
          ) : (
            <span className="topbar-title">HERMES-IDE</span>
          )}
        </div>

        {isFeatureFlagEnabled("attentionInbox") && (
          <Suspense fallback={null}>
            <AttentionCenter
              sessions={state.sessions}
              activeSessionId={state.activeSessionId}
              onJump={jumpToSession}
              onOpenChange={setAttentionInboxOpen}
              onStartTasks={openNewSession}
              canOpenOnStart={() => !anyOverlayOpenRef.current}
            />
          </Suspense>
        )}

      </div>

      <div
        className="app-body"
        style={{
          "--sidebar-w": `${fittedLeftRail.sidebarWidth}px`,
          "--side-panel-w": `${fittedLeftRail.sidePanelWidth}px`,
          // Right-rail width: when an agent session has the workbench
          // open, the panel uses its own viewport-ratio-derived width;
          // otherwise (terminal mode, workbench closed) we fall back to
          // the legacy local rightPanelWidth state.
          "--context-w": activeSession?.mode === "agent" && ui.workbench.open
            ? `${workbenchWidth}px`
            : `${rightPanelWidth}px`,
        } as React.CSSProperties}
      >
        {!ui.flowMode && (
          <ActivityBar
            side="left"
            pinnedTabs={[
              { id: "sessions", label: `${t("sessions.title")} (${shortcutLabel("view.toggle-sidebar")})`, icon: SessionsIcon, badge: sessions.length || undefined },
              { id: "library", label: t("app.library"), icon: LibraryIcon },
            ]}
            tabs={(() => {
              const filtered = pluginPanels
                .filter(p => (p.side === "left" || p.side === "bottom") && !pluginSessionActions.some(a => a.panelId === p.id))
                .map(p => ({
                  id: p.id,
                  label: p.name,
                  icon: <span dangerouslySetInnerHTML={{ __html: p.icon }} />,
                }));
              if (activityBarOrder.length === 0) return filtered;
              const orderMap = new Map(activityBarOrder.map((id, i) => [id, i]));
              return [...filtered].sort((a, b) => {
                const ai = orderMap.get(a.id) ?? 9999;
                const bi = orderMap.get(b.id) ?? 9999;
                return ai - bi;
              });
            })()}
            onReorder={(ids) => {
              setActivityBarOrder(ids);
              setSetting("activity_bar_order", JSON.stringify(ids)).catch(() => {});
            }}
            activeTabId={libraryOpen ? "library" : activePluginPanel ?? activeBottomPanel ?? (!ui.sessionListCollapsed ? "sessions" : null)}
            onTabClick={(tabId) => {
              if (tabId === "library") {
                setLibraryOpen((open) => !open);
              } else if (tabId === "sessions") {
                setActivePluginPanel(null);
                dispatch({ type: "TOGGLE_SIDEBAR" });
              } else {
                // Check if this is a bottom panel
                const isBottom = pluginPanels.some(p => p.id === tabId && p.side === "bottom");
                if (isBottom) {
                  setActiveBottomPanel(activeBottomPanel === tabId ? null : tabId);
                } else {
                  // Left plugin panel
                  if (activePluginPanel === tabId) {
                    setActivePluginPanel(null);
                  } else {
                    setActivePluginPanel(tabId);
                    dispatch({ type: "SET_SUBVIEW_PANEL", panel: null });
                  }
                }
              }
            }}
            topAction={{ icon: PlusIcon, label: `${t("session.new")} (${shortcutLabel("file.new-session")})`, onClick: openNewSession }}
            bottomActions={[
              { icon: PluginsIcon, label: t("app.plugins"), onClick: () => openSettings("plugins") },
              { icon: SettingsIcon, label: t("app.settings"), onClick: () => openSettings("general") },
            ]}
          />
        )}
        {/* Session list sidebar — sub-view buttons are inline under the active session */}
        {!ui.sessionListCollapsed && !ui.flowMode && !ui.processPanelOpen && !activePluginPanel && (
          <PanelErrorBoundary panelName="Session List">
            <SessionList
              sessions={sessions}
              activeSessionId={state.activeSessionId}
              onSelect={setActive}
              onClose={requestCloseSession}
              onNewSession={(group) => setSessionCreatorOpen({ group })}
              onReconnect={handleReconnect}
              activeView={
                ui.searchPanelOpen ? "search" :
                ui.fileExplorerOpen ? "files" :
                (reviewDeskEnabled ? reviewDeskOpen : ui.gitPanelOpen) ? "git" :
                null
              }
              onViewChange={(view: SessionView) => {
                if (view === "git" && reviewDeskEnabled) {
                  setReviewDeskOpen(true);
                  return;
                }
                if (view) setActivePluginPanel(null);
                dispatch({ type: "SET_SUBVIEW_PANEL", panel: view });
              }}
              gitViewTitle={reviewDeskEnabled ? t("palette.reviewDesk") : undefined}
              gitBadge={activeGitSummary.changeCount || undefined}
              pluginSessionActions={pluginSessionActions}
              activePluginPanel={activePluginPanel}
              onPluginActionClick={(_actionId, panelId) => {
                if (activePluginPanel === panelId) {
                  setActivePluginPanel(null);
                } else {
                  dispatch({ type: "SET_SUBVIEW_PANEL", panel: null });
                  setActivePluginPanel(panelId);
                }
              }}
            />
          </PanelErrorBoundary>
        )}
        {sessionListVisible && secondPanelOpen && (
          <PanelResizeHandle direction="horizontal" onResize={handleLeftResize} onResizeEnd={refitActive} />
        )}
        {gitPanelOpen && !ui.flowMode && !activePluginPanel && state.activeSessionId && (
          <PanelErrorBoundary panelName="Git Panel">
            <Suspense fallback={null}>
              <SessionGitPanel sessionId={state.activeSessionId} projectId="" />
            </Suspense>
          </PanelErrorBoundary>
        )}
        {ui.processPanelOpen && !ui.flowMode && !activePluginPanel && (
          <PanelErrorBoundary panelName="Process Panel">
            <Suspense fallback={null}>
              <ProcessPanel visible={ui.processPanelOpen} />
            </Suspense>
          </PanelErrorBoundary>
        )}
        {ui.fileExplorerOpen && !ui.flowMode && !activePluginPanel && (
          <Suspense fallback={null}>
            <FileExplorerPanel visible={ui.fileExplorerOpen} />
          </Suspense>
        )}
        {ui.searchPanelOpen && !ui.flowMode && !activePluginPanel && (
          <Suspense fallback={null}>
            <SearchPanel visible={ui.searchPanelOpen} onAddProject={() => setProjectPickerOpen(true)} />
          </Suspense>
        )}
        {activePluginPanel && !ui.flowMode && (() => {
          const panelMeta = pluginPanels.find(p => p.id === activePluginPanel && p.side === "left");
          if (!panelMeta) return null;
          const PanelComponent = pluginRuntime.getPanelComponent(activePluginPanel);
          if (!PanelComponent) return null;
          return (
            <div className="plugin-side-panel">
              <PluginPanelHost pluginId={panelMeta.pluginId} panelId={activePluginPanel} panelName={panelMeta.name}>
                <PanelComponent pluginId={panelMeta.pluginId} panelId={activePluginPanel} />
              </PluginPanelHost>
            </div>
          );
        })()}
        <PluginUpdateBanner
          updater={pluginUpdater}
          toastStore={toastStore}
          onShowUpdateConfirm={() => setPendingUpdatePlugins([...pluginUpdater.updatesAvailable])}
        />
        {!ui.flowMode && (!ui.sessionListCollapsed || gitPanelOpen || ui.processPanelOpen || ui.fileExplorerOpen || ui.searchPanelOpen || (activePluginPanel && pluginPanels.some(p => p.id === activePluginPanel && p.side === "left"))) && (
          <PanelResizeHandle direction="horizontal" onResize={sidePanelVisible ? handleSidePanelResize : handleLeftResize} onResizeEnd={refitActive} />
        )}
        <div className="main-area">
          <div className="terminal-and-timeline">
            {ui.filePreview && state.activeSessionId ? (
              <div className="file-preview-main-container">
                {(() => {
                  const handler = pluginRuntime?.getFileHandler(ui.filePreview.filePath);
                  return (
                    <PanelErrorBoundary panelName="File Preview">
                      <Suspense fallback={null}>
                        <FilePreviewPanel
                          sessionId={state.activeSessionId}
                          projectId={ui.filePreview.projectId}
                          filePath={ui.filePreview.filePath}
                          onBack={() => dispatch({ type: "CLOSE_FILE_PREVIEW" })}
                          fileHandler={handler?.component}
                          fileHandlerPluginId={handler?.pluginId}
                        />
                      </Suspense>
                    </PanelErrorBoundary>
                  );
                })()}
              </div>
            ) : (
            <div className="terminal-container">
              {state.layout.root ? (
                <SplitLayout node={state.layout.root} />
              ) : (
                <EmptyState
                  recentSessions={state.recentSessions}
                  onNew={() => {
                    console.log("[opening-overlay] EmptyState 'New Session' clicked");
                    openNewSession();
                  }}
                  onOpenPalette={() => dispatch({ type: "TOGGLE_PALETTE" })}
                  onToggleContext={() => dispatch({ type: "TOGGLE_CONTEXT" })}
                  onRestore={(entry, restoreScrollback) => createSession({ label: entry.label, workingDirectory: entry.working_directory, restoreFromId: restoreScrollback ? entry.id : undefined })}
                />
              )}
            </div>
            )}
            {/* Mounted once any Agent-view session exists (not only while
                one is active), so unsent image attachments survive a
                switch to a terminal session and back. The composer renders
                nothing for non-agent sessions. */}
            {libraryOpen && (
              <PanelErrorBoundary panelName="Library">
                <Suspense fallback={null}>
                  <LibraryView onClose={() => setLibraryOpen(false)} onStartTask={() => void openTaskLauncher(true)} />
                </Suspense>
              </PanelErrorBoundary>
            )}
            {hasAgentSession(sessions) && (
              <PanelErrorBoundary panelName="Composer">
                <Suspense fallback={null}>
                  <SessionComposer />
                </Suspense>
              </PanelErrorBoundary>
            )}
          </div>
          {/* Right rail.
           *
           *  Agent-mode sessions get the new Workbench (1.1.14) — a
           *  per-session right rail with Files / Context tabs and a
           *  Notes drawer.  Replaces both the per-session-row folder
           *  icon and the legacy AgentContextPanel mount.  Default
           *  open; toggled from the activity bar (or ⌥⌘B).
           *
           *  Terminal-mode (and any other) sessions keep the legacy
           *  toggleable ContextPanel + UsagePanel pair.
           */}
          {!ui.flowMode && activeSession?.mode === "agent" && ui.workbench.open && (
            <PanelErrorBoundary panelName="Workbench">
              <Suspense fallback={null}>
                <WorkbenchPanel session={activeSession} />
              </Suspense>
            </PanelErrorBoundary>
          )}
          {featureTracksOn && ui.trackPanelOpen && !ui.flowMode && activeSession && (
            <>
              <PanelResizeHandle direction="horizontal" onResize={handleRightResize} onResizeEnd={refitActive} />
              <PanelErrorBoundary panelName="Track">
                <Suspense fallback={null}>
                  <TrackPanel
                    session={activeSession}
                    sessions={sessions}
                    onOpenInEditorSplit={(path) => { void openTrackFileInSplit(path); }}
                    onSendToWriter={sendLineToSession}
                    onClose={() => dispatch({ type: "TOGGLE_TRACK" })}
                  />
                </Suspense>
              </PanelErrorBoundary>
            </>
          )}
          {ui.contextPanelOpen && !ui.flowMode && activeSession && activeSession.mode !== "agent" && (
            <>
              <PanelResizeHandle direction="horizontal" onResize={handleRightResize} onResizeEnd={refitActive} />
              <PanelErrorBoundary panelName="Context Panel">
                <Suspense fallback={null}>
                  <ContextPanel session={activeSession} />
                </Suspense>
              </PanelErrorBoundary>
            </>
          )}
          {ui.contextPanelOpen && !ui.flowMode && !activeSession && (
            <>
              <PanelResizeHandle direction="horizontal" onResize={handleRightResize} onResizeEnd={refitActive} />
              <PanelErrorBoundary panelName="Context Panel">
                <aside className="context-panel" aria-label={t("empty.contextPanelTitle")}>
                  <div className="context-panel-header">
                    <span className="context-panel-title">{t("empty.contextPanelTitle")}</span>
                  </div>
                  <div className="context-panel-body">
                    <section className="ctx-section">
                      <div className="ctx-section-title">{t("empty.beginSession")}</div>
                      <p className="text-muted">{t("empty.contextPanelPlaceholder")}</p>
                    </section>
                  </div>
                </aside>
              </PanelErrorBoundary>
            </>
          )}
          {/* Usage panel.  Mounted for both agent and terminal sessions,
              mutex with the right-rail occupant of the moment:
              - terminal: mutex with ContextPanel (same column)
              - agent:    mutex with WorkbenchPanel (same column)
              When the user clicks the Usage activity-bar tab on an
              agent session, the click handler closes the workbench
              first so this clause renders. */}
          {ui.usagePanelOpen && !ui.contextPanelOpen && !ui.flowMode && activeSession &&
            (activeSession.mode !== "agent" || !ui.workbench.open) && (
            <>
              {activeSession.mode !== "agent" && (
                <PanelResizeHandle direction="horizontal" onResize={handleRightResize} onResizeEnd={refitActive} />
              )}
              <PanelErrorBoundary panelName="Usage Panel">
                <Suspense fallback={null}>
                  <UsagePanel session={activeSession} />
                </Suspense>
              </PanelErrorBoundary>
            </>
          )}
        </div>
        {!ui.flowMode && (
          <ActivityBar
            side="right"
            tabs={[
              ...(featureTracksOn && activeSession ? [{ id: "track", label: t("app.track"), icon: TrackIcon }] : []),
              ...(activeSession?.mode === "agent"
                ? [
                    {
                      id: "workbench",
                      label: `${t("app.workbench")} (${fmt("{mod}{alt}B")})`,
                      icon: WorkbenchIcon,
                    },
                    { id: "usage", label: t("app.usage"), icon: UsageIcon },
                  ]
                : [
                    { id: "context", label: `${t("app.context")} (${shortcutLabel("view.context-panel")})`, icon: ContextIcon },
                    { id: "usage", label: t("app.usage"), icon: UsageIcon },
                  ]),
            ]}
            activeTabId={
              featureTracksOn && ui.trackPanelOpen && activeSession
                ? "track"
                : activeSession?.mode === "agent"
                ? ui.workbench.open
                  ? "workbench"
                  : ui.usagePanelOpen
                    ? "usage"
                    : null
                : ui.contextPanelOpen
                  ? "context"
                  : ui.usagePanelOpen
                    ? "usage"
                    : null
            }
            onTabClick={(tabId) => {
              // Right-rail tabs are mutex within the same column — clicking
              // one tab implicitly closes whatever else was occupying the
              // panel.  TOGGLE_USAGE / TOGGLE_CONTEXT / TOGGLE_WORKBENCH
              // are independent flags in state, so we mirror the mutex
              // here in the dispatch handler.
              if (tabId === "track") {
                if (ui.usagePanelOpen) dispatch({ type: "TOGGLE_USAGE" });
                if (ui.contextPanelOpen) dispatch({ type: "TOGGLE_CONTEXT" });
                if (!ui.trackPanelOpen && ui.workbench.open) dispatch({ type: "SET_WORKBENCH_OPEN", open: false });
                dispatch({ type: "TOGGLE_TRACK" });
              } else if (tabId === "workbench") {
                if (ui.usagePanelOpen) dispatch({ type: "TOGGLE_USAGE" });
                if (ui.trackPanelOpen) dispatch({ type: "TOGGLE_TRACK" });
                dispatch({ type: "TOGGLE_WORKBENCH" });
              } else if (tabId === "context") {
                if (ui.usagePanelOpen) dispatch({ type: "TOGGLE_USAGE" });
                dispatch({ type: "TOGGLE_CONTEXT" });
              } else if (tabId === "usage") {
                // Closing the workbench when opening Usage so the right
                // column has room.  If Usage is already open, this is a
                // toggle-off → leave the workbench in whatever state it
                // was in.
                if (!ui.usagePanelOpen && ui.workbench.open) {
                  dispatch({ type: "SET_WORKBENCH_OPEN", open: false });
                }
                dispatch({ type: "TOGGLE_USAGE" });
              }
            }}
          />
        )}
      </div>

      {/* Bottom plugin panels (e.g. Pixel Office) — independent of left sidebar */}
      {activeBottomPanel && !ui.flowMode && (() => {
        const panelMeta = pluginPanels.find(p => p.id === activeBottomPanel && p.side === "bottom");
        if (!panelMeta) return null;
        const PanelComponent = pluginRuntime.getPanelComponent(activeBottomPanel);
        if (!PanelComponent) return null;
        return (
          <div style={{ height: bottomPanelHeight, minHeight: 120, maxHeight: "80vh", flexShrink: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <PanelResizeHandle direction="vertical" onResize={handleBottomResize} onResizeEnd={refitActive} />
            <div style={{ flex: 1, overflow: "hidden" }}>
              <PluginPanelHost pluginId={panelMeta.pluginId} panelId={activeBottomPanel} panelName={panelMeta.name}>
                <PanelComponent pluginId={panelMeta.pluginId} panelId={activeBottomPanel} />
              </PluginPanelHost>
            </div>
          </div>
        );
      })()}

      <StatusBar
        onOpenShortcuts={() => setShortcutsOpen(true)}
        updateAvailable={updater.state.available}
        updateVersion={updater.state.version}
        updateDownloading={updater.state.downloading}
        updateProgress={updater.state.progress}
        updateChecking={updater.state.checking}
        onShowUpdate={() => updater.manualCheck()}
        onCheckForUpdates={() => void checkForUpdatesNow()}
      />

      {ui.commandPaletteOpen && (
        <Suspense fallback={null}>
        <CommandPalette
          onClose={() => dispatch({ type: "TOGGLE_PALETTE" })}
          sessions={sidebarSessions}
          onCloseSession={state.activeSessionId ? () => { if (state.activeSessionId) requestCloseSession(state.activeSessionId); } : undefined}
          onCloseSessionRemoveWorktree={state.activeSessionId ? () => { if (state.activeSessionId) requestCloseSession(state.activeSessionId); } : undefined}
          activeSessionId={state.activeSessionId}
          onSelectSession={setActive}
          onNewSession={openNewSession}
          onToggleContext={() => dispatch({ type: "TOGGLE_CONTEXT" })}
          onToggleSessions={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          onOpenSettings={(tab) => openSettings(tab || "general")}
          onOpenWorkspace={() => setWorkspaceOpen(true)}
          onOpenCostDashboard={fleetOn ? undefined : () => setCostDashboardOpen(true)}
          onToggleFlowMode={() => dispatch({ type: "TOGGLE_FLOW_MODE" })}
          onTileWorkingAgents={isFeatureFlagEnabled("fleetPerf") ? () => {
            // What the agents reported: a plain shell's busy prompt (the
            // terminal's own guess) is not an agent at work.
            const ids = workingSessionIds(sidebarSessions, (id) => lastReportedStatus(getSessionEventSnapshot(id))?.kind ?? "idle");
            if (ids.length === 0) {
              toastStore.addToast({ message: t("fleet.noWorkingAgents"), type: "info", duration: 3000 });
              return;
            }
            dispatch({ type: "TILE_SESSIONS", sessionIds: ids });
          } : undefined}
          onAttachProject={() => setProjectPickerOpen(true)}
          onOpenComposer={() => dispatch({ type: "OPEN_COMPOSER" })}
          onOpenLibrary={() => setLibraryOpen(true)}
          onOpenShortcuts={() => { setShortcutsOpen(true); }}
          onToggleGit={reviewDeskEnabled ? toggleReviewDesk : () => dispatch({ type: "TOGGLE_GIT_PANEL" })}
          reviewDesk={reviewDeskEnabled}
          onToggleSearch={() => dispatch({ type: "TOGGLE_SEARCH_PANEL" })}
          onToggleTrack={featureTracksOn ? () => dispatch({ type: "TOGGLE_TRACK" }) : undefined}
          onApproveGate={featureTracksOn ? () => { void approveActiveGate(); } : undefined}
          onMakeFeature={featureTracksOn ? () => { void makeActiveFeature(); } : undefined}
          onScanCwd={() => {
            if (activeSession?.working_directory) {
              createProject(activeSession.working_directory, null).catch(console.error);
            }
          }}
          pluginCommands={pluginCommands}
          pluginsWithSettings={pluginsWithSettings}
          onPluginCommand={(commandId) => pluginRuntime.executeCommand(commandId)}
          onCheckPluginUpdates={async () => {
            await pluginUpdater.checkNow();
            if (pluginUpdater.updatesAvailable.length === 0) {
              toastStore.addToast({ message: "All plugins are up to date", type: "info", duration: 3000 });
            }
          }}
        />
        </Suspense>
      )}

      {shortcutsOpen && (
        <Suspense fallback={null}>
          <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />
        </Suspense>
      )}

      {reviewDeskEnabled && reviewDeskOpen && state.activeSessionId && (
        <PanelErrorBoundary panelName="Review Desk">
          <Suspense fallback={null}>
            <ReviewDesk sessionId={state.activeSessionId} sessions={sessions} onClose={() => setReviewDeskOpen(false)} />
          </Suspense>
        </PanelErrorBoundary>
      )}

      {costDashboardOpen && (
        <Suspense fallback={null}>
          <CostDashboard onClose={() => setCostDashboardOpen(false)} />
        </Suspense>
      )}

      {settingsOpen && (
        <Suspense fallback={null}>
        <Settings
          onClose={closeSettings}
          initialTab={settingsOpen}
          pluginRuntime={pluginRuntime}
          pluginRefreshTrigger={pluginUpdater.updateResults.length}
          onSignInAgent={(agentId) => void signInAgent(agentId)}
          onSignInAccount={(agentId, accountId) => void signInAccount(agentId, accountId)}
          onOpenAdvancedCreator={openAdvancedCreator}
          onConfirmPluginUpdate={(plugin) => {
            const info = pluginUpdater.updatesAvailable.find((u) => u.id === plugin.id);
            if (info) {
              setPendingUpdatePlugins([info]);
            } else {
              // Update not in checker state (e.g. auto-update cleared it, or check hasn't run yet)
              // Build the info from the registry plugin directly
              setPendingUpdatePlugins([{
                id: plugin.id,
                name: plugin.name,
                currentVersion: "",
                newVersion: plugin.version,
                downloadUrl: plugin.downloadUrl,
                changelog: plugin.changelog,
                icon: plugin.icon,
              }]);
            }
          }}
          onConfirmPluginUpdateAll={(plugins) => {
            const infos = plugins.map((plugin) => {
              const info = pluginUpdater.updatesAvailable.find((u) => u.id === plugin.id);
              return info ?? {
                id: plugin.id,
                name: plugin.name,
                currentVersion: "",
                newVersion: plugin.version,
                downloadUrl: plugin.downloadUrl,
                changelog: plugin.changelog,
                icon: plugin.icon,
              };
            });
            setPendingUpdatePlugins(infos);
          }}
        />
        </Suspense>
      )}

      {workspaceOpen && (
        <Suspense fallback={null}>
          <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
        </Suspense>
      )}

      {projectPickerOpen && activeSession && (
        <ProjectPicker sessionId={activeSession.id} onClose={() => setProjectPickerOpen(false)} />
      )}

      {pendingUpdatePlugins && pendingUpdatePlugins.length > 0 && (
        <PluginUpdateConfirmDialog
          plugins={pendingUpdatePlugins}
          onConfirm={() => {
            const plugins = pendingUpdatePlugins;
            setPendingUpdatePlugins(null);
            for (const p of plugins) {
              pluginUpdater.updatePlugin(p);
            }
          }}
          onCancel={() => setPendingUpdatePlugins(null)}
        />
      )}

      {taskLauncherOpen && (
        <Suspense fallback={null}>
          <TaskLauncher
            key={taskLauncherOpen.gen}
            defaultRepo={taskLauncherOpen.repo}
            focusNonce={taskLauncherOpen.focus}
            onClose={onTaskLauncherClosed}
            onOpenAdvanced={openAdvancedCreator}
            onSignIn={(agentId, accountId) => void (accountId ? signInAccount(agentId, accountId) : signInAgent(agentId))}
            onManageAccounts={() => openSettings("agents")}
            onStartOver={() => setTaskLauncherOpen((cur) => (cur ? { ...cur, gen: ++launcherGenRef.current } : cur))}
            onLaunch={runSheetLaunch}
          />
        </Suspense>
      )}

      {sessionCreatorOpen && (
        <Suspense fallback={null}>
        <SessionCreator
          defaultGroup={sessionCreatorOpen.group}
          onReady={() => {
            // SessionCreator finished its first useEffect — the modal
            // is mounted and visible.  Tear down the imperative
            // overlay (waits for the minimum-visible duration first
            // so the user actually sees it on instant-mount machines).
            void hideOpeningOverlay();
          }}
          onClose={() => {
            setSessionCreatorOpen(false);
            pendingSplit.current = null;
          }}
          onCreate={async (opts) => {
            // With a running-agents or memory cap and no free slot, an
            // agent task waits in the queue instead of starting (N22).
            if (fleet.queueIfFull(opts, opts.label || opts.agentName || getAgent(opts.aiProvider)?.name || opts.aiProvider || "")) {
              setSessionCreatorOpen(false);
              pendingSplit.current = null;
              return;
            }
            // Which session the focused pane shows right now — read BEFORE
            // createSession(), which makes the new session active and swaps
            // it into the focused pane.
            const focusedBefore = focusedPaneSnapshot(state.layout);
            // A worktree that could not be made (a toast says why) keeps the
            // wizard open with everything chosen, so another way can be
            // picked; a cancel closes it as before.
            let worktreeFailed = false;
            const onWorktreeErrors = (e: Event) => {
              if ((e as CustomEvent<{ fatal?: boolean }>).detail?.fatal) worktreeFailed = true;
            };
            window.addEventListener("hermes:worktree-errors", onWorktreeErrors);
            const session = await createSession(opts).finally(() => window.removeEventListener("hermes:worktree-errors", onWorktreeErrors));
            if (!session && worktreeFailed) return;
            setSessionCreatorOpen(false);
            if (session) {
              const split = pendingSplit.current;
              pendingSplit.current = null;
              if (split && state.layout.root) {
                // Split an existing pane (the focused pane gets its own
                // session back first, or the new one would show twice).
                for (const action of splitAfterCreateActions(focusedBefore, split, session.id)) dispatch(action);
              } else if (!state.layout.root) {
                // First session — init pane
                dispatch({ type: "INIT_PANE", sessionId: session.id });
              } else if (state.layout.focusedPaneId) {
                // Layout exists, no pending split — swap focused pane's session
                dispatch({ type: "SET_PANE_SESSION", paneId: state.layout.focusedPaneId, sessionId: session.id });
              }
            }
          }}
        />
        </Suspense>
      )}

      {ui.composerOpen && (
        <Suspense fallback={null}>
          <SessionPrompts sessionId={activeSession?.id ?? null} onClose={() => dispatch({ type: "CLOSE_COMPOSER" })} />
        </Suspense>
      )}

      {ui.flowMode && activeSession && (
        <FlowToast sessionId={activeSession.id} />
      )}

      <UpdateDialog
        state={updater.state}
        onDismiss={updater.dismiss}
        onDownload={updater.download}
        onCancel={updater.cancelDownload}
        onInstall={() =>
          updater.installAndRelaunch(async () => { await saveWorkspace(); })
        }
        onRelaunchNow={() =>
          updater.installAndRelaunch(async () => { await saveWorkspace(); }, { force: true })
        }
      />

      <OnboardingGate
        onLaunch={runTaskLaunch}
        onSignIn={(agentId, accountId) => void (accountId ? signInAccount(agentId, accountId) : signInAgent(agentId))}
        onOpenShell={() => void createSessionDirect()}
      />
      <LandSheetHost />
      <WhatsNewGate version={__APP_VERSION__} />

      {state.pendingCloseSessionId && (
        <CloseSessionDialog
          sessionId={state.pendingCloseSessionId}
          sessionMode={state.sessions[state.pendingCloseSessionId]?.mode}
          label={state.sessions[state.pendingCloseSessionId]?.label}
          agentName={(() => {
            const s = state.sessions[state.pendingCloseSessionId];
            return s ? agentDisplayName(s) ?? getAgent(s.ai_provider)?.name ?? null : null;
          })()}
          onConfirm={(id) => {
            dispatch({ type: "CANCEL_CLOSE_SESSION" });
            closeSession(id);
          }}
          onCancel={() => dispatch({ type: "CANCEL_CLOSE_SESSION" })}
          onDontAskAgain={() => {
            dispatch({ type: "SET_SKIP_CLOSE_CONFIRM", skip: true });
            setSetting("skip_close_confirm", "true").catch(console.warn);
          }}
        />
      )}

      {quitAsk && (quitAsk.length > 0 || queuedCount > 0) && (
        <QuitWithAgentsDialog
          sessions={quitAsk}
          queuedCount={queuedCount}
          onKeep={() => { void answerQuit(true); }}
          onStop={() => { void answerQuit(false); }}
          onCancel={() => setQuitAsk(null)}
        />
      )}

      <ToastContainer toasts={toastStore.toasts} onDismiss={toastStore.dismissToast} />
      {import.meta.env.VITE_HERMES_E2E === "1" && <DialogGalleryHost />}
      <WorktreeRecipePanel />

    </div>
  );
}

// ─── App Root ───────────────────────────────────────────────────────

function App() {
  // Two fences. The inner one sits INSIDE the session store, so a crash in
  // the window's UI can be reloaded without losing any session. The outer
  // one only catches a failure of the stores themselves.
  return (
    <ContainedErrorBoundary scope="app">
      <I18nProvider>
        <SessionProvider>
          <ContainedErrorBoundary scope="app">
            <AppContent />
          </ContainedErrorBoundary>
        </SessionProvider>
      </I18nProvider>
    </ContainedErrorBoundary>
  );
}

export default App;
