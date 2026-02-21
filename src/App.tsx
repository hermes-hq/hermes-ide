import { useState, useEffect, useCallback, useRef, Component, type ReactNode, type ErrorInfo } from "react";
import "./styles/layout.css";
import "./styles/topbar.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeToSession } from "./api/sessions";
import { createRealm } from "./api/realms";
import { SessionProvider, useSession, useActiveSession, useSessionList, useAutonomousSettings } from "./state/SessionContext";
import { SessionList } from "./components/SessionList";
import { ContextPanel } from "./components/ContextPanel";
import { StatusBar } from "./components/StatusBar";
import { CommandPalette } from "./components/CommandPalette";
import { EmptyState } from "./components/EmptyState";
import { StuckOverlay } from "./components/StuckOverlay";
import { Settings } from "./components/Settings";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { CostDashboard } from "./components/CostDashboard";
import { FlowToast } from "./components/FlowToast";
import { ExecutionTimeline } from "./components/ExecutionTimeline";
import { AutoToast } from "./components/AutoToast";
import { copyContextToClipboard } from "./utils/copyContextToClipboard";
import { RealmPicker } from "./components/RealmPicker";
import { SessionCreator } from "./components/SessionCreator";
import { PromptComposer } from "./components/PromptComposer";
import { SplitLayout } from "./components/SplitLayout";
import { SplitDirection, collectPanes } from "./state/layoutTypes";
import { decodeSessionDrag } from "./components/SplitPane";
import { focusTerminal } from "./terminal/TerminalPool";

function AppContent() {
  const { state, dispatch, createSession, closeSession, setActive } = useSession();
  const activeSession = useActiveSession();
  const sessions = useSessionList();
  const { ui } = state;
  const autoSettings = useAutonomousSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [costDashboardOpen, setCostDashboardOpen] = useState(false);
  const [realmPickerOpen, setRealmPickerOpen] = useState(false);
  const [sessionCreatorOpen, setSessionCreatorOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
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
            closeSession(state.activeSessionId);
          }
          break;
        case "e": e.preventDefault(); dispatch({ type: "TOGGLE_CONTEXT" }); break;
        case "k": e.preventDefault(); dispatch({ type: "TOGGLE_PALETTE" }); break;
        case "b": e.preventDefault(); dispatch({ type: "TOGGLE_SIDEBAR" }); break;
        case "j": e.preventDefault(); setComposerOpen((v) => !v); break;
        case "t": e.preventDefault(); dispatch({ type: "TOGGLE_TIMELINE" }); break;
        case ",": e.preventDefault(); setSettingsOpen((v) => !v); break;
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
  }, [state.activeSessionId, state.layout, sessions, activeSession, createSession, closeSession, dispatch, setActive]);

  const sendCtrlC = useCallback(() => {
    const id = ui.stuckOverlaySessionId;
    if (!id) return;
    writeToSession(id, btoa("\x03")).catch(console.error);
    dispatch({ type: "DISMISS_STUCK_OVERLAY" });
  }, [ui.stuckOverlaySessionId, dispatch]);

  const handleAutoExecute = useCallback(() => {
    if (!ui.autoToast) return;
    const { command, sessionId } = ui.autoToast;
    const data = btoa(command + "\r");
    writeToSession(sessionId, data).catch(console.error);
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

        {/* Left controls — interactive, opt out of drag */}
        <div className="topbar-controls">
          <button
            className="topbar-btn"
            onClick={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
            title="Toggle Sessions (⌘B)"
          >
            {ui.sessionListCollapsed ? "›" : "‹"}
            {sessions.length > 0 && <span className="topbar-badge">{sessions.length}</span>}
          </button>
          <button className="topbar-btn topbar-btn-new" onClick={() => setSessionCreatorOpen(true)} title="New Session (⌘N)">+</button>
        </div>

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

        {/* Right controls */}
        <div className="topbar-controls">
          <button
            className={`topbar-btn ${ui.contextPanelOpen ? "topbar-btn-active" : ""}`}
            onClick={() => dispatch({ type: "TOGGLE_CONTEXT" })}
            title="Toggle Context (⌘E)"
          >
            ctx
          </button>
        </div>
      </div>

      <div className="app-body">
        {!ui.sessionListCollapsed && !ui.flowMode && (
          <SessionList
            sessions={sessions}
            activeSessionId={state.activeSessionId}
            onSelect={setActive}
            onClose={closeSession}
          />
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
      </div>

      <StatusBar />

      {ui.commandPaletteOpen && (
        <CommandPalette
          onClose={() => dispatch({ type: "TOGGLE_PALETTE" })}
          sessions={sessions}
          onSelectSession={setActive}
          onNewSession={() => setSessionCreatorOpen(true)}
          onToggleContext={() => dispatch({ type: "TOGGLE_CONTEXT" })}
          onToggleSessions={() => dispatch({ type: "TOGGLE_SIDEBAR" })}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenWorkspace={() => setWorkspaceOpen(true)}
          onOpenCostDashboard={() => setCostDashboardOpen(true)}
          onToggleFlowMode={() => dispatch({ type: "TOGGLE_FLOW_MODE" })}
          onAttachRealm={() => setRealmPickerOpen(true)}
          onOpenComposer={() => setComposerOpen(true)}
          onScanCwd={() => {
            if (activeSession?.working_directory) {
              createRealm(activeSession.working_directory, null).catch(console.error);
            }
          }}
        />
      )}

      {costDashboardOpen && (
        <CostDashboard onClose={() => setCostDashboardOpen(false)} />
      )}

      {settingsOpen && (
        <Settings onClose={() => setSettingsOpen(false)} />
      )}

      {workspaceOpen && (
        <WorkspacePanel onClose={() => setWorkspaceOpen(false)} />
      )}

      {realmPickerOpen && activeSession && (
        <RealmPicker sessionId={activeSession.id} onClose={() => setRealmPickerOpen(false)} />
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
          onDismiss={() => dispatch({ type: "DISMISS_STUCK_OVERLAY" })}
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
