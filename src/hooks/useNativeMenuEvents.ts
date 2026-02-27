import { useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { ensureListener, registerMenuBarHandler } from "./nativeMenuBridge";

// ─── Menu Bar Action → React Dispatch Bridge ────────────────────────

interface MenuEventHandlers {
  dispatch: (action: { type: string; [key: string]: unknown }) => void;
  createSession: () => void;
  requestCloseSession: (id: string) => void;
  activeSessionId: string | null;
  focusedPaneId: string | null;
  setSettingsOpen: (v: string | null) => void;
  setComposerOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setShortcutsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setCostDashboardOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setSessionCreatorOpen: (v: boolean) => void;
  copyContextToClipboard: () => void;
  pendingSplit: React.MutableRefObject<{ paneId: string; direction: string } | null>;
}

export function useNativeMenuEvents(handlers: MenuEventHandlers): void {
  const {
    dispatch,
    createSession,
    activeSessionId,
    focusedPaneId,
    setSettingsOpen,
    setComposerOpen,
    setShortcutsOpen,
    setCostDashboardOpen,
    setSessionCreatorOpen,
    copyContextToClipboard,
    pendingSplit,
    requestCloseSession,
  } = handlers;

  const onMenuAction = useCallback(
    (actionId: string) => {
      switch (actionId) {
        // ── File menu ──
        case "file.new-session":
          createSession();
          break;
        case "file.close-pane":
          if (focusedPaneId) {
            dispatch({ type: "CLOSE_PANE", paneId: focusedPaneId });
          } else if (activeSessionId) {
            requestCloseSession(activeSessionId);
          }
          break;
        case "file.file-explorer":
          dispatch({ type: "TOGGLE_FILE_EXPLORER" });
          break;

        // ── Edit menu ──
        case "edit.find":
          dispatch({ type: "TOGGLE_SEARCH_PANEL" });
          break;

        // ── View menu ──
        case "view.toggle-sidebar":
          dispatch({ type: "TOGGLE_SIDEBAR" });
          break;
        case "view.command-palette":
          dispatch({ type: "TOGGLE_PALETTE" });
          break;
        case "view.prompt-composer":
          dispatch({ type: "CLOSE_PALETTE" });
          setComposerOpen((v: boolean) => !v);
          break;
        case "view.process-panel":
          dispatch({ type: "TOGGLE_PROCESS_PANEL" });
          break;
        case "view.git-panel":
          dispatch({ type: "TOGGLE_GIT_PANEL" });
          break;
        case "view.context-panel":
          dispatch({ type: "TOGGLE_CONTEXT" });
          break;
        case "view.timeline":
          dispatch({ type: "TOGGLE_TIMELINE" });
          break;
        case "view.search-panel":
          dispatch({ type: "TOGGLE_SEARCH_PANEL" });
          break;
        case "view.split-horizontal":
          dispatch({ type: "CLOSE_PALETTE" });
          if (focusedPaneId) {
            pendingSplit.current = { paneId: focusedPaneId, direction: "horizontal" };
            setSessionCreatorOpen(true);
          }
          break;
        case "view.split-vertical":
          dispatch({ type: "CLOSE_PALETTE" });
          if (focusedPaneId) {
            pendingSplit.current = { paneId: focusedPaneId, direction: "vertical" };
            setSessionCreatorOpen(true);
          }
          break;
        case "view.flow-mode":
          dispatch({ type: "TOGGLE_FLOW_MODE" });
          break;
        case "view.cost-dashboard":
          dispatch({ type: "CLOSE_PALETTE" });
          setCostDashboardOpen((v: boolean) => !v);
          break;
        case "view.shortcuts":
          dispatch({ type: "CLOSE_PALETTE" });
          setShortcutsOpen((v: boolean) => !v);
          break;

        // ── Session menu ──
        case "session.copy-context":
          copyContextToClipboard();
          break;

        // ── Settings ──
        case "hermes.settings":
          dispatch({ type: "CLOSE_PALETTE" });
          setSettingsOpen("general");
          break;

        // ── Help menu ──
        case "help.website":
          open("https://hermes-ide.com");
          break;
        case "help.legal":
          open("https://hermes-ide.com/legal");
          break;
        case "help.report-bug":
          open("https://forms.gle/6KKQkqBYq8GE1Kh96");
          break;
        case "help.shortcuts":
          dispatch({ type: "CLOSE_PALETTE" });
          setShortcutsOpen(true);
          break;
      }
    },
    [
      dispatch,
      createSession,
      activeSessionId,
      focusedPaneId,
      setSettingsOpen,
      setComposerOpen,
      setShortcutsOpen,
      setCostDashboardOpen,
      setSessionCreatorOpen,
      copyContextToClipboard,
      pendingSplit,
      requestCloseSession,
    ],
  );

  useEffect(() => {
    ensureListener();
    const cleanup = registerMenuBarHandler(onMenuAction);
    return cleanup;
  }, [onMenuAction]);
}
