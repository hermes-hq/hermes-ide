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
import { triggerMenuBarActionFromKeyboard } from "./hooks/nativeMenuBridge";
import { createProject } from "./api/projects";
import { SessionProvider, useSession, useActiveSession, useSessionList, useSidebarOrderedSessions } from "./state/SessionContext";
import { getSetting } from "./api/settings";
import { workingDirectoryRecoveryMessage, reusedCheckoutMessage, type WorkingDirectoryRecovery, type ReusedCheckout } from "./state/isolation";
import { SessionList } from "./components/SessionList";
import { hideOpeningOverlay, showOpeningOverlay } from "./utils/sessionCreatorOverlay";
import { ActivityBar, SessionsIcon, ContextIcon, UsageIcon, WorkbenchIcon, PlusIcon, PluginsIcon, SettingsIcon, TrackIcon } from "./components/ActivityBar";
import { useTrackWatching } from "./track/useTrackWatching";
import { editorCommandFor } from "./track/rules";
import { getTrackState, noteOwnApproval } from "./track/store";
import { trackApprove, trackPromote } from "./track/api";
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
import { sessionHostQuit } from "./api/sessions";
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
import { focusTerminal, refitActive } from "./terminal/TerminalPool";
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
import { PluginUpdateConfirmDialog } from "./components/PluginUpdateConfirmDialog";
import { launchFailedMessage } from "./catalog/agentCatalog";
import { isFeatureFlagEnabled } from "./featureFlags";
import { OnboardingGate } from "./components/OnboardingGate";
import { getAgent } from "./catalog/agentCatalog";
import { getProjectsOrdered, getSessionProjects } from "./api/projects";
import { getSessionWorktreeInfo } from "./api/git";
import { writeTaskFeatureFile } from "./api/launcher";
import { handleUndeliveredTask, launchTask, normalizeRepoPath, type UndeliveredTask } from "./launcher/launchTask";
import { TASK_LAUNCHES_KEY } from "./launcher/taskLauncher";
import type { TaskLaunchRequest } from "./components/TaskLauncher";
import { WhatsNewGate } from "./components/WhatsNewGate";
import { ContainedErrorBoundary } from "./components/ContainedErrorBoundary";
import { PanelResizeHandle } from "./components/PanelResizeHandle";
import { useFleetControls } from "./fleet/useFleetControls";
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
const PromptComposer = lazyView("PromptComposer", () => import("./components/PromptComposer").then((m) => m.PromptComposer));
const ShortcutsPanel = lazyView("ShortcutsPanel", () => import("./components/ShortcutsPanel").then((m) => m.ShortcutsPanel));
const WorkspacePanel = lazyView("WorkspacePanel", () => import("./components/WorkspacePanel").then((m) => m.WorkspacePanel));
const CostDashboard = lazyView("CostDashboard", () => import("./components/CostDashboard").then((m) => m.CostDashboard));

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
  const [taskLauncherOpen, setTaskLauncherOpen] = useState<false | { repo: string | null }>(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
      const { branchName } = event.payload;
      toastStoreRef.current.addToast({
        message: `Failed to clean up branch worktree '${branchName}'. It will be retried on next startup.`,
        type: "warning",
        duration: 8000,
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
    listen<{ id: string; label: string }[]>("session-host-quit-requested", (event) => {
      if (cancelled) return;
      setQuitAsk(event.payload.map((s) => ({ id: s.id, label: s.label })));
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
  const startQueuedTask = useCallback(async (opts: CreateSessionOpts) => {
    const before = activeIdRef.current;
    const session = await createSession(opts);
    if (session) {
      if (!layoutRootRef.current) dispatch({ type: "INIT_PANE", sessionId: session.id });
      else if (before) dispatch({ type: "SET_ACTIVE", id: before });
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

  /** ⌘N: the launcher, on the repository of the active session. */
  const openTaskLauncher = useCallback(async () => {
    const s = activeSessionRef.current;
    let repo: string | null = null;
    if (s && !s.ssh_info) {
      try {
        repo = (await getSessionProjects(s.id))[0]?.path ?? s.working_directory;
      } catch {
        repo = s.working_directory;
      }
    }
    setTaskLauncherOpen({ repo });
  }, []);

  const openNewSession = useCallback(() => {
    if (launcherOn) void openTaskLauncher();
    else setSessionCreatorOpen({});
  }, [launcherOn, openTaskLauncher, setSessionCreatorOpen]);

  /** ⌘⇧N: the full creator. */
  const openAdvancedCreator = useCallback(() => {
    setTaskLauncherOpen(false);
    setSessionCreatorOpen({});
  }, [setSessionCreatorOpen]);

  /** Sign in: the agent's own CLI in a terminal, where it asks the person to sign in. */
  const signInAgent = useCallback(async (agentId: string) => {
    setTaskLauncherOpen(false);
    const session = await createSession({
      aiProvider: agentId,
      mode: "terminal",
      label: t("agentError.signInSessionLabel", { agent: getAgent(agentId)?.name ?? agentId }),
    });
    if (session) showSession(session.id);
  }, [createSession, showSession, t]);

  const runTaskLaunch = useCallback(async (req: TaskLaunchRequest) => {
    const result = await launchTask(req, {
      projectFor: async (root) => {
        const want = normalizeRepoPath(root, PLATFORM === "win");
        const known = (await getProjectsOrdered()).find((p) => normalizeRepoPath(p.path, PLATFORM === "win") === want);
        return known ? known.id : (await createProject(root, null)).id;
      },
      createSession,
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
      worktreePath: async (sessionId, projectId) => (await getSessionWorktreeInfo(sessionId, projectId))?.worktreePath ?? null,
      writeFeatureFile: writeTaskFeatureFile,
      copyText: (text) => navigator.clipboard.writeText(text),
      readRecords: () => getSetting(TASK_LAUNCHES_KEY).catch(() => ""),
      writeRecords: (raw) => setSetting(TASK_LAUNCHES_KEY, raw),
      now: () => Date.now(),
    });
    if (result.ok) setTaskLauncherOpen(false);
    return result.ok;
  }, [createSession, dispatch, showSession]);

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
  const sendLineToSession = useCallback((sessionId: string, line: string) => writeToSession(sessionId, utf8ToBase64(`${line}\r`)), []);
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
      toastStore.addToast({ message: t("track.approvedToast", { slug: feature.slug, from: move.from, to: move.to }), type: "success", duration: 4000 });
    } catch (e) {
      toastStore.addToast({ message: String(e), type: "error", duration: 5000 });
    }
  }, [activeSession, toastStore, t]);
  /** Palette: "Make it a feature" for the active worktree (Light track). */
  const makeActiveFeature = useCallback(async () => {
    if (!activeSession) return;
    const track = getTrackState(activeSession.working_directory);
    try {
      const out = await trackPromote(activeSession.working_directory, slugFromBranch(track.branch, activeSession.working_directory), "Light", null);
      const made = t("track.featureCreated", { slug: out.slug, track: "Light" });
      toastStore.addToast({ message: out.branch ? `${made} — ${out.branch}` : made, type: "success", duration: 4000 });
      if (!ui.trackPanelOpen) dispatch({ type: "TOGGLE_TRACK" });
    } catch (e) {
      toastStore.addToast({ message: String(e), type: "error", duration: 5000 });
    }
  }, [activeSession, toastStore, ui.trackPanelOpen, dispatch, t]);

  // ── Native menu bar event bridge ──
  useNativeMenuEvents({
    dispatch,
    createSession: openNewSession,
    createSessionAdvanced: openAdvancedCreator,
    createSessionDirect,
    requestCloseSession,
    activeSessionId: state.activeSessionId,
    focusedPaneId: state.layout.focusedPaneId,
    setSettingsOpen,
    setShortcutsOpen,
    setCostDashboardOpen,
    setSessionCreatorOpen,
    copyContextToClipboard: () => copyContextToClipboard(activeSession),
    pendingSplit,
    onCheckForUpdates: () => updater.manualCheck(),
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
            <AttentionCenter sessions={state.sessions} activeSessionId={state.activeSessionId} onJump={jumpToSession} onOpenChange={setAttentionInboxOpen} />
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
            activeTabId={activePluginPanel ?? activeBottomPanel ?? (!ui.sessionListCollapsed ? "sessions" : null)}
            onTabClick={(tabId) => {
              if (tabId === "sessions") {
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
              { icon: PluginsIcon, label: t("app.plugins"), onClick: () => setSettingsOpen("plugins") },
              { icon: SettingsIcon, label: t("app.settings"), onClick: () => setSettingsOpen("general") },
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
            <SearchPanel visible={ui.searchPanelOpen} />
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
        onShowUpdate={() => updater.manualCheck()}
        onCheckForUpdates={() => updater.manualCheck()}
      />

      {ui.commandPaletteOpen && (
        <Suspense fallback={null}>
        <CommandPalette
          onClose={() => dispatch({ type: "TOGGLE_PALETTE" })}
          sessions={sessions}
          onSelectSession={setActive}
          onNewSession={openNewSession}
          onToggleContext={() => dispatch({ type: "TOGGLE_CONTEXT" })}
          onToggleSessions={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          onOpenSettings={(tab) => setSettingsOpen(tab || "general")}
          onOpenWorkspace={() => setWorkspaceOpen(true)}
          onOpenCostDashboard={fleetOn ? undefined : () => setCostDashboardOpen(true)}
          onToggleFlowMode={() => dispatch({ type: "TOGGLE_FLOW_MODE" })}
          onAttachProject={() => setProjectPickerOpen(true)}
          onOpenComposer={() => dispatch({ type: "OPEN_COMPOSER" })}
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
          onClose={() => setSettingsOpen(null)}
          initialTab={settingsOpen}
          pluginRuntime={pluginRuntime}
          pluginRefreshTrigger={pluginUpdater.updateResults.length}
          onSignInAgent={(agentId) => void signInAgent(agentId)}
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
            defaultRepo={taskLauncherOpen.repo}
            onClose={() => setTaskLauncherOpen(false)}
            onOpenAdvanced={openAdvancedCreator}
            onSignIn={(agentId) => void signInAgent(agentId)}
            onLaunch={runTaskLaunch}
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
            const session = await createSession(opts);
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

      {ui.composerOpen && activeSession && (
        <Suspense fallback={null}>
          <PromptComposer
            sessionId={activeSession.id}
            onClose={() => dispatch({ type: "CLOSE_COMPOSER" })}
            addToast={toastStore.addToast}
          />
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
        onSignIn={(agentId) => void signInAgent(agentId)}
        onOpenShell={() => void createSessionDirect()}
      />
      <LandSheetHost />
      <WhatsNewGate version={__APP_VERSION__} />

      {state.pendingCloseSessionId && (
        <CloseSessionDialog
          sessionId={state.pendingCloseSessionId}
          sessionMode={state.sessions[state.pendingCloseSessionId]?.mode}
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

      {quitAsk && quitAsk.length > 0 && (
        <QuitWithAgentsDialog
          sessions={quitAsk}
          onKeep={() => { void answerQuit(true); }}
          onStop={() => { void answerQuit(false); }}
          onCancel={() => setQuitAsk(null)}
        />
      )}

      <ToastContainer toasts={toastStore.toasts} onDismiss={toastStore.dismissToast} />
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
