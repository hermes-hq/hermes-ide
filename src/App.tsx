import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from "react";
import "./styles/layout.css";
import "./styles/themes.css";
import "./styles/topbar.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeToSession } from "./api/sessions";
import { sendShortcutCommand } from "./terminal/TerminalPool";
import { createProject } from "./api/projects";
import { SessionProvider, useSession, useActiveSession, useSessionList, useAutonomousSettings } from "./state/SessionContext";
import { SessionList } from "./components/SessionList";
import { ContextPanel } from "./components/ContextPanel";
import { ActivityBar, SessionsIcon, ContextIcon, PlusIcon, ProcessesIcon } from "./components/ActivityBar";
import { ProcessPanel } from "./components/ProcessPanel";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { StuckOverlay } from "./components/StuckOverlay";
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
import { setSetting } from "./api/settings";
import { SplitDirection, collectPanes } from "./state/layoutTypes";
import { decodeSessionDrag } from "./components/SplitPane";
import { focusTerminal } from "./terminal/TerminalPool";
import { DebugPanel } from "./debug/DebugPanel";

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
  const [composerOpen, setComposerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const pendingSplit = useRef<{ paneId: string; direction: SplitDirection } | null>(null);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey) return;

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

      // Shift combos
      if (e.shiftKey) {
        switch (e.key) {
          case "D": case "d":
            // Cmd+Shift+D → vertical split
            e.preventDefault();
            if (state.layout.focusedPaneId) {
              pendingSplit.current = { paneId: state.layout.focusedPaneId, direction: "vertical" };
              setSessionCreatorOpen(true);
            }
            return;
          case "F": case "f": e.preventDefault(); dispatch({ type: "TOGGLE_FLOW_MODE" }); return;
          case "C": case "c": e.preventDefault(); copyContextToClipboard(activeSession); return;
        }
      }
      switch (e.key) {
        case "d":
          // Cmd+D → horizontal split
          e.preventDefault();
          if (state.layout.focusedPaneId) {
            pendingSplit.current = { paneId: state.layout.focusedPaneId, direction: "horizontal" };
            setSessionCreatorOpen(true);
          }
          break;
        case "n": e.preventDefault(); setSessionCreatorOpen(true); break;
        case "w":
          e.preventDefault();
          if (state.layout.focusedPaneId && state.layout.root) {
            // Close just the pane, keep the session alive
            dispatch({ type: "CLOSE_PANE", paneId: state.layout.focusedPaneId });
          } else if (state.activeSessionId) {
            requestCloseSession(state.activeSessionId);
          }
          break;
        case "e": e.preventDefault(); dispatch({ type: "TOGGLE_CONTEXT" }); break;
        case "k": e.preventDefault(); dispatch({ type: "TOGGLE_PALETTE" }); break;
        case "b": e.preventDefault(); dispatch({ type: "TOGGLE_SIDEBAR" }); break;
        case "j": e.preventDefault(); setComposerOpen((v) => !v); break;
        case "p": e.preventDefault(); dispatch({ type: "TOGGLE_PROCESS_PANEL" }); break;
        case "t": e.preventDefault(); dispatch({ type: "TOGGLE_TIMELINE" }); break;
        case ",": e.preventDefault(); setSettingsOpen((v) => v ? null : "general"); break;
        case "/": e.preventDefault(); setShortcutsOpen((v) => !v); break;
        case "$": e.preventDefault(); setCostDashboardOpen((v) => !v); break;
        default:
          if (e.key >= "1" && e.key <= "9") {
            e.preventDefault();
            const idx = parseInt(e.key) - 1;
            if (idx < sessions.length) setActive(sessions[idx].id);
          }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.activeSessionId, state.layout, sessions, activeSession, createSession, closeSession, requestCloseSession, dispatch, setActive]);

  const sendCtrlC = useCallback(() => {
    const id = ui.stuckOverlaySessionId;
    if (!id) return;
    writeToSession(id, btoa("\x03")).catch(console.error);
    dispatch({ type: "DISMISS_STUCK_OVERLAY", sessionId: id });
  }, [ui.stuckOverlaySessionId, dispatch]);

  const handleAutoExecute = useCallback(() => {
    if (!ui.autoToast) return;
    const { command, sessionId } = ui.autoToast;
    sendShortcutCommand(sessionId, command);
    dispatch({ type: "DISMISS_AUTO_TOAST" });
  }, [ui.autoToast, dispatch]);

  const stuckSession = ui.stuckOverlaySessionId ? state.sessions[ui.stuckOverlaySessionId] : null;

  // Re-focus the active terminal when the app window regains focus
  // (e.g. after a system dialog, Cmd+Tab, or notification steals focus).
  // Uses Tauri's onFocusChanged (reliable in WKWebView) + browser fallbacks.
  useEffect(() => {
    if (!activeSession) return;
    const sessionId = activeSession.id;

    // Tauri window focus event — most reliable in WKWebView
    let unlistenTauri: (() => void) | null = null;
    getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) focusTerminal(sessionId);
    }).then((u) => { unlistenTauri = u; });

    // Browser fallbacks for edge cases
    const onFocus = () => focusTerminal(sessionId);
    const onVisibility = () => {
      if (document.visibilityState === "visible") focusTerminal(sessionId);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      unlistenTauri?.();
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [activeSession]);

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

  return (
    <div className={`app ${ui.flowMode ? "flow-mode" : ""}`}>
      {/* Top bar */}
      <div className="topbar">
        {/* Traffic light spacer */}
        <div className="topbar-traffic-spacer" />

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

      <div className="app-body">
        {!ui.flowMode && (
          <ActivityBar
            side="left"
            tabs={[
              { id: "sessions", label: "Sessions (⌘B)", icon: SessionsIcon, badge: sessions.length || undefined },
              { id: "processes", label: "Processes (⌘P)", icon: ProcessesIcon },
            ]}
            activeTabId={
              ui.processPanelOpen ? "processes" :
              ui.sessionListCollapsed ? null : "sessions"
            }
            onTabClick={(tabId) => dispatch({ type: "SET_LEFT_TAB", tab: tabId as "sessions" | "processes" })}
            topAction={{ icon: PlusIcon, label: "New Session (⌘N)", onClick: () => setSessionCreatorOpen(true) }}
          />
        )}
        {!ui.sessionListCollapsed && !ui.flowMode && !ui.processPanelOpen && (
          <SessionList
            sessions={sessions}
            activeSessionId={state.activeSessionId}
            onSelect={setActive}
            onClose={requestCloseSession}
          />
        )}
        {ui.processPanelOpen && !ui.flowMode && (
          <ProcessPanel visible={ui.processPanelOpen} />
        )}
        <div className="main-area">
          <div className="terminal-and-timeline">
            <div
              className="terminal-container"
              onDragOver={(e) => {
                if (!state.layout.root) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(e) => {
                if (!state.layout.root) {
                  e.preventDefault();
                  const raw = e.dataTransfer.getData("text/plain");
                  const droppedSessionId = decodeSessionDrag(raw);
                  if (droppedSessionId) {
                    dispatch({ type: "INIT_PANE", sessionId: droppedSessionId });
                  }
                }
              }}
            >
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
              { id: "context", label: "Context (⌘E)", icon: ContextIcon },
            ]}
            activeTabId={ui.contextPanelOpen ? "context" : null}
            onTabClick={() => dispatch({ type: "TOGGLE_CONTEXT" })}
          />
        )}
      </div>

      <StatusBar onOpenShortcuts={() => setShortcutsOpen(true)} />

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
          onOpenComposer={() => setComposerOpen(true)}
          onOpenShortcuts={() => { setShortcutsOpen(true); }}
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

      {composerOpen && activeSession && (
        <PromptComposer
          sessionId={activeSession.id}
          onClose={() => setComposerOpen(false)}
        />
      )}

      {stuckSession && (
        <StuckOverlay
          session={stuckSession}
          onDismiss={() => dispatch({ type: "DISMISS_STUCK_OVERLAY", sessionId: stuckSession.id })}
          onSendCtrlC={sendCtrlC}
        />
      )}

      {ui.flowMode && activeSession && (
        <FlowToast sessionId={activeSession.id} />
      )}

      {/* Auto Toast (F3) */}
      {ui.autoToast && (
        <AutoToast
          command={ui.autoToast.command}
          reason={ui.autoToast.reason as "prediction" | "error_fix"}
          delayMs={autoSettings.cancelDelayMs}
          onCancel={() => dispatch({ type: "DISMISS_AUTO_TOAST" })}
          onExecute={handleAutoExecute}
        />
      )}

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

      {/* Diagnostic debug panel — only renders when HERMES_DEBUG is active */}
      <DebugPanel />
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
