import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from "react";
import React from "react";
import ReactDOM from "react-dom";
import { PluginRuntime } from "./plugins/PluginRuntime";
import { PluginLoader } from "./plugins/PluginLoader";
import { builtinPlugins } from "./plugins/builtin";
import { usePluginRuntime } from "./plugins/usePluginRuntime";
import { PluginPanelHost } from "./plugins/PluginPanelHost";

// Expose React and ReactDOM as globals for dynamically loaded plugins.
// Plugins are IIFE bundles that externalize React and reference window.React.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).React = React;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).ReactDOM = ReactDOM;
import "./styles/layout.css";
import "./styles/themes.css";
import "./styles/topbar.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendShortcutCommand } from "./terminal/TerminalPool";
import { fmt, isActionMod, isMac } from "./utils/platform";
import { createProject } from "./api/projects";
import { SessionProvider, useSession, useActiveSession, useSessionList, useSidebarOrderedSessions, useAutonomousSettings } from "./state/SessionContext";
import { getSetting } from "./api/settings";
import { SessionList } from "./components/SessionList";
import { ContextPanel } from "./components/ContextPanel";
import { ActivityBar, SessionsIcon, ContextIcon, PlusIcon, PluginsIcon, SettingsIcon } from "./components/ActivityBar";
import type { SessionView } from "./components/SessionList";

import { ProcessPanel } from "./components/ProcessPanel";
import { FileExplorerPanel } from "./components/FileExplorerPanel";
import { FilePreviewPanel } from "./components/FilePreviewPanel";
import { SearchPanel } from "./components/SearchPanel";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { CloseSessionDialog } from "./components/CloseSessionDialog";
import { Settings } from "./components/Settings";
import { ShortcutsPanel } from "./components/ShortcutsPanel";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { CostDashboard } from "./components/CostDashboard";
import { FlowToast } from "./components/FlowToast";
import { ExecutionTimeline } from "./components/ExecutionTimeline";
import { AutoToast } from "./components/AutoToast";
import { copyContextToClipboard } from "./utils/copyContextToClipboard";
import { ProjectPicker } from "./components/ProjectPicker";
import { SessionCreator } from "./components/SessionCreator";
import { PromptComposer } from "./components/PromptComposer";
import { SplitLayout } from "./components/SplitLayout";
import { SessionGitPanel } from "./components/SessionGitPanel";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { setSetting } from "./api/settings";
import { SplitDirection, collectPanes } from "./state/layoutTypes";
import { getDraggedSession } from "./components/SplitPane";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { focusTerminal, refitActive } from "./terminal/TerminalPool";
import { useNativeMenuEvents } from "./hooks/useNativeMenuEvents";
import { useMenuStateSync } from "./hooks/useMenuStateSync";
import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { usePluginUpdateChecker } from "./hooks/usePluginUpdateChecker";
import { useSessionGitSummary } from "./hooks/useSessionGitSummary";
import { listen } from "@tauri-apps/api/event";
import { UpdateDialog } from "./components/UpdateDialog";
import { PluginUpdateBanner } from "./components/PluginUpdateBanner";
import { ToastContainer } from "./components/ToastContainer";
import { useToastStore } from "./hooks/useToastStore";
import { WhatsNewDialog } from "./components/WhatsNewDialog";
import { PluginUpdateConfirmDialog } from "./components/PluginUpdateConfirmDialog";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { AI_PROVIDERS as AI_PROVIDER_LIST } from "./utils/aiProviders";

const AI_PROVIDER_INFO_MAP: Record<string, { label: string; installCmd: string }> = Object.fromEntries(
  AI_PROVIDER_LIST.map((p) => [p.id, { label: p.label, installCmd: p.installCmd }])
);
import { PanelResizeHandle } from "./components/PanelResizeHandle";

function AppContent() {
  const { state, dispatch, createSession, closeSession, requestCloseSession, setActive, saveWorkspace } = useSession();
  const activeSession = useActiveSession();
  const sessions = useSessionList();
  const sidebarSessions = useSidebarOrderedSessions();
  const { ui } = state;
  const autoSettings = useAutonomousSettings();
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [costDashboardOpen, setCostDashboardOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [sessionCreatorOpen, setSessionCreatorOpen] = useState<false | { group?: string }>(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [cmdPaletteShortcut, setCmdPaletteShortcut] = useState("cmd_k");
  const pendingSplit = useRef<{ paneId: string; direction: SplitDirection } | null>(null);
  const updater = useAutoUpdater();
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
  const [leftPanelWidth, setLeftPanelWidth] = useState(240);
  const [rightPanelWidth, setRightPanelWidth] = useState(300);
  const toastStore = useToastStore();
  const toastStoreRef = useRef(toastStore);
  toastStoreRef.current = toastStore;

  const handleLeftResize = useCallback((delta: number) => {
    setLeftPanelWidth((w) => Math.max(180, Math.min(480, w + delta)));
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

  // ── AI launch failure notification ──
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    listen<string>("ai-launch-failed", (event) => {
      if (cancelled) return;
      const provider = event.payload;
      const providerInfo = AI_PROVIDER_INFO_MAP[provider];
      toastStoreRef.current.addToast({
        message: `${providerInfo?.label ?? provider} CLI was not found. Install with: ${providerInfo?.installCmd ?? provider}`,
        type: "warning",
        duration: 15000,
      });
    }).then((u) => {
      if (cancelled) { u(); } else { unlisten = u; }
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── Shared worktree warning ──
  useEffect(() => {
    const handler = (e: Event) => {
      const { branches } = (e as CustomEvent).detail as { branches: string[]; sessionLabel: string };
      const branchList = branches.join(", ");
      toastStoreRef.current.addToast({
        message: `Sharing worktree for ${branchList} with another session. Changes to files will affect both sessions — avoid editing the same files.`,
        type: "warning",
        duration: 10000,
      });
    };
    window.addEventListener("hermes:shared-worktree", handler);
    return () => window.removeEventListener("hermes:shared-worktree", handler);
  }, []);

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
    });
    pluginRuntimeRef.current = runtime;
    for (const plugin of builtinPlugins) {
      runtime.register(plugin);
    }
    return runtime;
  });

  const { commands: pluginCommands, panels: pluginPanels, pluginsWithSettings, sessionActions: pluginSessionActions } = usePluginRuntime(pluginRuntime);
  const pluginUpdater = usePluginUpdateChecker(pluginRuntime);
  const [pendingUpdatePlugins, setPendingUpdatePlugins] = useState<typeof pluginUpdater.updatesAvailable | null>(null);

  useEffect(() => {
    const loader = new PluginLoader(pluginRuntime);
    // Load external plugins from disk, then activate all startup plugins
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

  // Keyboard shortcuts — only those NOT handled by native menu bar
  // (Cmd+Alt+Arrow for pane nav, Cmd+1-9 for session switch, F1/F3 for overlays)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isActionMod(e)) return;

      // Cmd+Shift+P — always toggles command palette (alternative shortcut)
      if (e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        dispatch({ type: "TOGGLE_PALETTE" });
        return;
      }

      // Suppress session-switch shortcuts while any modal/overlay is open
      const anyOverlayOpen = ui.commandPaletteOpen || !!settingsOpen || ui.composerOpen || sessionCreatorOpen || shortcutsOpen || costDashboardOpen || workspaceOpen || projectPickerOpen;
      if (anyOverlayOpen) return;

      // Alt combos — pane navigation
      if (e.altKey && state.layout.root) {
        const panes = collectPanes(state.layout.root);
        if (panes.length > 1) {
          const currentIdx = panes.findIndex((p) => p.id === state.layout.focusedPaneId);
          let nextIdx = -1;
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            nextIdx = (currentIdx + 1) % panes.length;
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            nextIdx = (currentIdx - 1 + panes.length) % panes.length;
          }
          if (nextIdx >= 0) {
            dispatch({ type: "FOCUS_PANE", paneId: panes[nextIdx].id });
          }
        }
        return;
      }

      // Cmd+1-9 — session switch (matches sidebar visual order)
      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < sidebarSessions.length) setActive(sidebarSessions[idx].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.layout, sidebarSessions, dispatch, setActive, ui.commandPaletteOpen, settingsOpen, ui.composerOpen, sessionCreatorOpen, shortcutsOpen, costDashboardOpen, workspaceOpen, projectPickerOpen]);

  const handleReconnect = useCallback(async (session: import("./types/session").SessionData) => {
    if (!session.ssh_info) return;
    const { host, port, user, tmux_session, identity_file } = session.ssh_info;
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
    });
  }, [closeSession, createSession]);

  const handleAutoExecute = useCallback(() => {
    if (!ui.autoToast) return;
    const { command, sessionId } = ui.autoToast;
    sendShortcutCommand(sessionId, command);
    dispatch({ type: "DISMISS_AUTO_TOAST" });
  }, [ui.autoToast, dispatch]);

  // Re-focus the active terminal when the app window regains focus
  // (e.g. after a system dialog, Cmd+Tab, or notification steals focus).
  // Uses Tauri's onFocusChanged (reliable in WKWebView) + browser fallbacks.
  // Skips re-focus when any modal/overlay with input fields is open so it
  // doesn't steal focus from text inputs inside overlays.
  const activeSessionIdRef = useRef(activeSession?.id ?? null);
  activeSessionIdRef.current = activeSession?.id ?? null;
  const anyOverlayOpenRef = useRef(false);
  anyOverlayOpenRef.current = !!(ui.commandPaletteOpen || settingsOpen || ui.composerOpen || sessionCreatorOpen || shortcutsOpen || costDashboardOpen || workspaceOpen || projectPickerOpen);

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
  // Intercept the window close event to persist session state for restore on next launch.
  // Uses both Tauri's onCloseRequested (primary) and browser beforeunload (fallback).
  const saveWorkspaceRef = useRef(saveWorkspace);
  saveWorkspaceRef.current = saveWorkspace;
  const workspaceSavedRef = useRef(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWindow().onCloseRequested(async (event) => {
      if (workspaceSavedRef.current) return; // Already saved, let it close
      event.preventDefault();
      workspaceSavedRef.current = true;
      try {
        await saveWorkspaceRef.current();
      } catch (err) {
        console.error("[App] Failed to save workspace on close:", err);
      }
      getCurrentWindow().destroy();
    }).then((u) => { unlisten = u; });

    // Fallback: browser beforeunload — fire-and-forget save
    const onBeforeUnload = () => {
      if (workspaceSavedRef.current) return;
      workspaceSavedRef.current = true;
      saveWorkspaceRef.current().catch(console.error);
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      unlisten?.();
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

  // ── Native menu bar event bridge ──
  useNativeMenuEvents({
    dispatch,
    createSession: () => setSessionCreatorOpen({}),
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
  });

  // ── Sync UI toggle state → native menu checkmarks ──
  useMenuStateSync({
    sidebarVisible: !ui.sessionListCollapsed,
    processPanelOpen: ui.processPanelOpen,
    gitPanelOpen: ui.gitPanelOpen,
    contextPanelOpen: ui.contextPanelOpen,
    timelineOpen: ui.timelineOpen,
    searchPanelOpen: ui.searchPanelOpen,
    flowMode: ui.flowMode,
  });

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

      </div>

      <div className="app-body" style={{ "--sidebar-w": `${leftPanelWidth}px`, "--context-w": `${rightPanelWidth}px` } as React.CSSProperties}>
        {!ui.flowMode && (
          <ActivityBar
            side="left"
            pinnedTabs={[
              { id: "sessions", label: `Sessions (${fmt("{mod}B")})`, icon: SessionsIcon, badge: sessions.length || undefined },
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
            topAction={{ icon: PlusIcon, label: `New Session (${fmt("{mod}N")})`, onClick: () => setSessionCreatorOpen({}) }}
            bottomActions={[
              { icon: PluginsIcon, label: "Plugins", onClick: () => setSettingsOpen("plugins") },
              { icon: SettingsIcon, label: "Settings", onClick: () => setSettingsOpen("general") },
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
                ui.gitPanelOpen ? "git" :
                null
              }
              onViewChange={(view: SessionView) => {
                if (view) setActivePluginPanel(null);
                dispatch({ type: "SET_SUBVIEW_PANEL", panel: view });
              }}
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
        {ui.gitPanelOpen && !ui.flowMode && !activePluginPanel && state.activeSessionId && (
          <PanelErrorBoundary panelName="Git Panel">
            <SessionGitPanel sessionId={state.activeSessionId} projectId="" />
          </PanelErrorBoundary>
        )}
        {ui.processPanelOpen && !ui.flowMode && !activePluginPanel && (
          <PanelErrorBoundary panelName="Process Panel">
            <ProcessPanel visible={ui.processPanelOpen} />
          </PanelErrorBoundary>
        )}
        {ui.fileExplorerOpen && !ui.flowMode && !activePluginPanel && (
          <FileExplorerPanel visible={ui.fileExplorerOpen} />
        )}
        {ui.searchPanelOpen && !ui.flowMode && !activePluginPanel && (
          <SearchPanel visible={ui.searchPanelOpen} />
        )}
        {activePluginPanel && !ui.flowMode && (() => {
          const panelMeta = pluginPanels.find(p => p.id === activePluginPanel && p.side === "left");
          if (!panelMeta) return null;
          const PanelComponent = pluginRuntime.getPanelComponent(activePluginPanel);
          if (!PanelComponent) return null;
          return (
            <div style={{ width: "var(--sidebar-w)", flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-1)", overflow: "hidden" }}>
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
        {!ui.flowMode && (!ui.sessionListCollapsed || ui.gitPanelOpen || ui.processPanelOpen || ui.fileExplorerOpen || ui.searchPanelOpen || (activePluginPanel && pluginPanels.some(p => p.id === activePluginPanel && p.side === "left"))) && (
          <PanelResizeHandle direction="horizontal" onResize={handleLeftResize} onResizeEnd={refitActive} />
        )}
        <div className="main-area">
          <div className="terminal-and-timeline">
            {ui.filePreview && state.activeSessionId ? (
              <div className="file-preview-main-container">
                {(() => {
                  const handler = pluginRuntime?.getFileHandler(ui.filePreview.filePath);
                  return (
                    <FilePreviewPanel
                      sessionId={state.activeSessionId}
                      projectId={ui.filePreview.projectId}
                      filePath={ui.filePreview.filePath}
                      onBack={() => dispatch({ type: "CLOSE_FILE_PREVIEW" })}
                      fileHandler={handler?.component}
                      fileHandlerPluginId={handler?.pluginId}
                    />
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
                  onNew={() => setSessionCreatorOpen({})}
                  onRestore={(entry, restoreScrollback) => createSession({ label: entry.label, workingDirectory: entry.working_directory, restoreFromId: restoreScrollback ? entry.id : undefined })}
                />
              )}
            </div>
            )}
            {/* Execution Timeline (F1) */}
            {ui.timelineOpen && activeSession && (
              <ExecutionTimeline
                sessionId={activeSession.id}
                color={activeSession.color}
              />
            )}
          </div>
          {ui.contextPanelOpen && !ui.flowMode && activeSession && (
            <>
              <PanelResizeHandle direction="horizontal" onResize={handleRightResize} onResizeEnd={refitActive} />
              <PanelErrorBoundary panelName="Context Panel">
                <ContextPanel session={activeSession} />
              </PanelErrorBoundary>
            </>
          )}
        </div>
        {!ui.flowMode && (
          <ActivityBar
            side="right"
            tabs={[
              { id: "context", label: `Context (${fmt("{mod}E")})`, icon: ContextIcon },
            ]}
            activeTabId={ui.contextPanelOpen ? "context" : null}
            onTabClick={() => dispatch({ type: "TOGGLE_CONTEXT" })}
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
        <CommandPalette
          onClose={() => dispatch({ type: "TOGGLE_PALETTE" })}
          sessions={sessions}
          onSelectSession={setActive}
          onNewSession={() => setSessionCreatorOpen({})}
          onToggleContext={() => dispatch({ type: "TOGGLE_CONTEXT" })}
          onToggleSessions={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          onOpenSettings={(tab) => setSettingsOpen(tab || "general")}
          onOpenWorkspace={() => setWorkspaceOpen(true)}
          onOpenCostDashboard={() => setCostDashboardOpen(true)}
          onToggleFlowMode={() => dispatch({ type: "TOGGLE_FLOW_MODE" })}
          onAttachProject={() => setProjectPickerOpen(true)}
          onOpenComposer={() => dispatch({ type: "OPEN_COMPOSER" })}
          onOpenShortcuts={() => { setShortcutsOpen(true); }}
          onToggleGit={() => dispatch({ type: "TOGGLE_GIT_PANEL" })}
          onToggleSearch={() => dispatch({ type: "TOGGLE_SEARCH_PANEL" })}
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
      )}

      {shortcutsOpen && (
        <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />
      )}

      {costDashboardOpen && (
        <CostDashboard onClose={() => setCostDashboardOpen(false)} />
      )}

      {settingsOpen && (
        <Settings
          onClose={() => setSettingsOpen(null)}
          initialTab={settingsOpen}
          pluginRuntime={pluginRuntime}
          pluginRefreshTrigger={pluginUpdater.updateResults.length}
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
      )}

      {workspaceOpen && (
        <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
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

      {sessionCreatorOpen && (
        <SessionCreator
          defaultGroup={sessionCreatorOpen.group}
          onClose={() => {
            setSessionCreatorOpen(false);
            pendingSplit.current = null;
          }}
          onCreate={async (opts) => {
            const session = await createSession(opts);
            setSessionCreatorOpen(false);
            if (session) {
              const split = pendingSplit.current;
              pendingSplit.current = null;
              if (split && state.layout.root) {
                // Split an existing pane
                dispatch({ type: "SPLIT_PANE", paneId: split.paneId, direction: split.direction, newSessionId: session.id });
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
      )}

      {ui.composerOpen && activeSession && (
        <PromptComposer
          sessionId={activeSession.id}
          onClose={() => dispatch({ type: "CLOSE_COMPOSER" })}
        />
      )}

      {ui.flowMode && activeSession && (
        <FlowToast sessionId={activeSession.id} />
      )}

      {/* Auto Toast (F3) */}
      {ui.autoToast && (
        <AutoToast
          command={ui.autoToast.command}
          reason={ui.autoToast.reason as "prediction"}
          delayMs={autoSettings.cancelDelayMs}
          onCancel={() => dispatch({ type: "DISMISS_AUTO_TOAST" })}
          onExecute={handleAutoExecute}
        />
      )}

      <UpdateDialog
        state={updater.state}
        onDismiss={updater.dismiss}
        onDownload={updater.download}
        onCancel={updater.cancelDownload}
        onInstall={async () => {
          await saveWorkspace();
          await updater.installAndRelaunch();
        }}
      />

      <OnboardingWizard />
      <WhatsNewDialog version={__APP_VERSION__} />

      {state.pendingCloseSessionId && (
        <CloseSessionDialog
          sessionId={state.pendingCloseSessionId}
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

      <ToastContainer toasts={toastStore.toasts} onDismiss={toastStore.dismissToast} />

    </div>
  );
}

// ─── Error Boundary ─────────────────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary] Uncaught error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-title">Something went wrong</div>
          <pre className="error-boundary-stack">
            {this.state.error?.message}
          </pre>
          <button
            className="error-boundary-retry"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── App Root ───────────────────────────────────────────────────────

function App() {
  return (
    <ErrorBoundary>
      <SessionProvider>
        <AppContent />
      </SessionProvider>
    </ErrorBoundary>
  );
}

export default App;
