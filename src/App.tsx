import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from "react";
import "./styles/layout.css";
import "./styles/themes.css";
import "./styles/topbar.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendShortcutCommand } from "./terminal/TerminalPool";
import { fmt, isActionMod, isMac } from "./utils/platform";
import { createProject } from "./api/projects";
import { SessionProvider, useSession, useActiveSession, useSessionList, useAutonomousSettings } from "./state/SessionContext";
import { SessionList } from "./components/SessionList";
import { ContextPanel } from "./components/ContextPanel";
import { ActivityBar, SessionsIcon, ContextIcon, PlusIcon, SettingsIcon } from "./components/ActivityBar";
import type { SessionView } from "./components/SessionList";

import { ProcessPanel } from "./components/ProcessPanel";
import { FileExplorerPanel } from "./components/FileExplorerPanel";
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
import { setSetting } from "./api/settings";
import { SplitDirection, collectPanes } from "./state/layoutTypes";
import { getDraggedSession } from "./components/SplitPane";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { focusTerminal } from "./terminal/TerminalPool";
import { useNativeMenuEvents } from "./hooks/useNativeMenuEvents";
import { useMenuStateSync } from "./hooks/useMenuStateSync";
import { useAutoUpdater } from "./hooks/useAutoUpdater";
import { useSessionGitSummary } from "./hooks/useSessionGitSummary";
import { UpdateDialog } from "./components/UpdateDialog";
import { WhatsNewDialog } from "./components/WhatsNewDialog";

function AppContent() {
  const { state, dispatch, createSession, closeSession, requestCloseSession, setActive } = useSession();
  const activeSession = useActiveSession();
  const sessions = useSessionList();
  const { ui } = state;
  const autoSettings = useAutonomousSettings();
  const [settingsOpen, setSettingsOpen] = useState<string | null>(null);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [costDashboardOpen, setCostDashboardOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [sessionCreatorOpen, setSessionCreatorOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const pendingSplit = useRef<{ paneId: string; direction: SplitDirection } | null>(null);
  const updater = useAutoUpdater();
  const activeGitSummary = useSessionGitSummary(state.activeSessionId, !!activeSession);

  // Keyboard shortcuts — only those NOT handled by native menu bar
  // (Cmd+Alt+Arrow for pane nav, Cmd+1-9 for session switch, F1/F3 for overlays)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isActionMod(e)) return;

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

      // Cmd+1-9 — session switch
      if (e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = parseInt(e.key) - 1;
        if (idx < sessions.length) setActive(sessions[idx].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.layout, sessions, dispatch, setActive, ui.commandPaletteOpen, settingsOpen, ui.composerOpen, sessionCreatorOpen, shortcutsOpen, costDashboardOpen, workspaceOpen, projectPickerOpen]);

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
  useEffect(() => {
    const win = getCurrentWindow();
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest(".topbar")) return;
      if (target.closest("button") || target.closest("input") || target.closest(".topbar-controls")) return;
      win.startDragging().catch(() => {});
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, []);

  // ── Global contextmenu suppression ──
  // Capture-phase listener prevents the browser context menu on ALL surfaces.
  // Components with custom menus call e.stopPropagation() to intercept first.
  useEffect(() => {
    const suppress = (e: Event) => { e.preventDefault(); };
    document.addEventListener("contextmenu", suppress, true);
    return () => document.removeEventListener("contextmenu", suppress, true);
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
    createSession: () => setSessionCreatorOpen(true),
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
              {activeGitSummary.branch && (
                <span className="topbar-branch">
                  <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10" aria-hidden="true">
                    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                  </svg>
                  {activeGitSummary.branch}
                </span>
              )}
            </>
          ) : (
            <span className="topbar-title">HERMES-IDE</span>
          )}
        </div>

      </div>

      <div className="app-body">
        {!ui.flowMode && (
          <ActivityBar
            side="left"
            tabs={[
              { id: "sessions", label: `Sessions (${fmt("{mod}B")})`, icon: SessionsIcon, badge: sessions.length || undefined },
            ]}
            activeTabId={!ui.sessionListCollapsed ? "sessions" : null}
            onTabClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
            topAction={{ icon: PlusIcon, label: `New Session (${fmt("{mod}N")})`, onClick: () => setSessionCreatorOpen(true) }}
            bottomAction={{ icon: SettingsIcon, label: "Settings", onClick: () => setSettingsOpen("general") }}
          />
        )}
        {/* Session list sidebar — sub-view buttons are inline under the active session */}
        {!ui.sessionListCollapsed && !ui.flowMode && !ui.processPanelOpen && (
          <SessionList
            sessions={sessions}
            activeSessionId={state.activeSessionId}
            onSelect={setActive}
            onClose={requestCloseSession}
            onNewSession={() => setSessionCreatorOpen(true)}
            activeView={
              ui.searchPanelOpen ? "search" :
              ui.fileExplorerOpen ? "files" :
              ui.gitPanelOpen ? "git" :
              null
            }
            onViewChange={(view: SessionView) => {
              dispatch({ type: "SET_SUBVIEW_PANEL", panel: view });
            }}
            gitBadge={activeGitSummary.changeCount || undefined}
          />
        )}
        {ui.gitPanelOpen && !ui.flowMode && state.activeSessionId && (
          <SessionGitPanel sessionId={state.activeSessionId} realmId="" />
        )}
        {ui.processPanelOpen && !ui.flowMode && (
          <ProcessPanel visible={ui.processPanelOpen} />
        )}
        {ui.fileExplorerOpen && !ui.flowMode && (
          <FileExplorerPanel visible={ui.fileExplorerOpen} />
        )}
        {ui.searchPanelOpen && !ui.flowMode && (
          <SearchPanel visible={ui.searchPanelOpen} />
        )}
        <div className="main-area">
          <div className="terminal-and-timeline">
            <div className="terminal-container">
              {state.layout.root ? (
                <SplitLayout node={state.layout.root} />
              ) : (
                <EmptyState
                  recentSessions={state.recentSessions}
                  onNew={() => setSessionCreatorOpen(true)}
                  onRestore={(entry, restoreScrollback) => createSession({ label: entry.label, workingDirectory: entry.working_directory, restoreFromId: restoreScrollback ? entry.id : undefined })}
                />
              )}
            </div>
            {/* Execution Timeline (F1) */}
            {ui.timelineOpen && activeSession && (
              <ExecutionTimeline
                sessionId={activeSession.id}
                color={activeSession.color}
              />
            )}
          </div>
          {ui.contextPanelOpen && !ui.flowMode && activeSession && (
            <ContextPanel session={activeSession} />
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

      <StatusBar
        onOpenShortcuts={() => setShortcutsOpen(true)}
        updateAvailable={updater.state.available}
        updateVersion={updater.state.version}
        updateDownloading={updater.state.downloading}
        updateProgress={updater.state.progress}
        onShowUpdate={() => updater.manualCheck()}
      />

      {ui.commandPaletteOpen && (
        <CommandPalette
          onClose={() => dispatch({ type: "TOGGLE_PALETTE" })}
          sessions={sessions}
          onSelectSession={setActive}
          onNewSession={() => setSessionCreatorOpen(true)}
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
        />
      )}

      {shortcutsOpen && (
        <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />
      )}

      {costDashboardOpen && (
        <CostDashboard onClose={() => setCostDashboardOpen(false)} />
      )}

      {settingsOpen && (
        <Settings onClose={() => setSettingsOpen(null)} initialTab={settingsOpen} />
      )}

      {workspaceOpen && (
        <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
      )}

      {projectPickerOpen && activeSession && (
        <ProjectPicker sessionId={activeSession.id} onClose={() => setProjectPickerOpen(false)} />
      )}

      {sessionCreatorOpen && (
        <SessionCreator
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
        onInstall={updater.installAndRelaunch}
      />

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
