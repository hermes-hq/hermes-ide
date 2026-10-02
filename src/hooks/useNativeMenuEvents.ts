import { useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { ensureListener, registerMenuBarHandler } from "./nativeMenuBridge";
import { PLATFORM, OS_VERSION } from "../utils/platform";
import { trackFeatureUsed } from "../utils/analytics";
import { clearTerminal } from "../terminal/TerminalPool";
import { closeTopOverlay, topOverlay } from "../state/overlays";

const TRACKED_ACTIONS: Record<string, string> = {
  "view.git-panel": "git_panel",
  "view.prompt-composer": "prompt_composer",
  "hermes.settings": "settings",
  "view.command-palette": "command_palette",
  "view.flow-mode": "flow_mode",
  "view.cost-dashboard": "cost_dashboard",
  "view.context-panel": "context_panel",
  "view.search-panel": "search_panel",
  "view.split-horizontal": "split_pane",
  "view.split-vertical": "split_pane",
  "file.file-explorer": "file_explorer",
};

/** Window keys that do nothing while an overlay is open (they act on panes and sessions behind it). */
const OVERLAY_BLOCKED_ACTIONS = new Set([
  "file.new-session-tab",
  "view.split-horizontal",
  "view.split-vertical",
  "session.close-session",
]);

// ─── Menu Bar Action → React Dispatch Bridge ────────────────────────

interface MenuEventHandlers {
  dispatch: (action: any) => void;
  createSession: () => void;
  /** The full creator (SSH, tmux, an existing branch); ⌘⇧N. */
  createSessionAdvanced: () => void;
  createSessionDirect: () => void;
  requestCloseSession: (id: string) => void;
  activeSessionId: string | null;
  focusedPaneId: string | null;
  setSettingsOpen: (v: string | null) => void;
  setShortcutsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setCostDashboardOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  setSessionCreatorOpen: (v: false | { group?: string }) => void;
  copyContextToClipboard: () => void;
  pendingSplit: React.MutableRefObject<{ paneId: string; direction: string } | null>;
  onCheckForUpdates: () => void;
  commandPaletteShortcut: string;
  /** F21: with the reviewDesk flag on, ⌘G opens the Review Desk instead of the git panel. */
  toggleReviewDesk?: () => void;
}

export function useNativeMenuEvents(handlers: MenuEventHandlers): void {
  const {
    dispatch,
    createSession,
    createSessionAdvanced,
    createSessionDirect,
    activeSessionId,
    focusedPaneId,
    setSettingsOpen,
    setShortcutsOpen,
    setCostDashboardOpen,
    setSessionCreatorOpen,
    copyContextToClipboard,
    pendingSplit,
    requestCloseSession,
    onCheckForUpdates,
    commandPaletteShortcut,
    toggleReviewDesk,
  } = handlers;

  const onMenuAction = useCallback(
    (actionId: string) => {
      const trackedFeature = TRACKED_ACTIONS[actionId];
      if (trackedFeature) trackFeatureUsed(trackedFeature);

      // An overlay (the launcher, the palette, Settings…) is in front: the
      // window keys act on it, never on the workspace hidden behind it.
      // ⌘W closes it (the launcher keeps its draft); the keys that would
      // add, split or end a pane or a session do nothing.
      if (topOverlay()) {
        if (actionId === "file.close-pane") {
          closeTopOverlay();
          return;
        }
        if (OVERLAY_BLOCKED_ACTIONS.has(actionId)) return;
      }

      switch (actionId) {
        // ── File menu ──
        case "file.new-session":
          createSession();
          break;
        case "file.new-session-advanced":
          createSessionAdvanced();
          break;
        case "file.new-session-tab":
          createSessionDirect();
          break;
        case "file.close-pane":
          if (focusedPaneId) {
            dispatch({ type: "CLOSE_PANE", paneId: focusedPaneId });
          } else if (activeSessionId) {
            requestCloseSession(activeSessionId);
          }
          break;
        case "session.close-session":
          if (activeSessionId) requestCloseSession(activeSessionId);
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
          if (commandPaletteShortcut === "cmd_shift_p" && activeSessionId) {
            // CMD+K clears terminal when palette is remapped to CMD+Shift+P
            clearTerminal(activeSessionId);
          } else {
            dispatch({ type: "TOGGLE_PALETTE" });
          }
          break;
        case "view.prompt-composer":
          dispatch({ type: "CLOSE_PALETTE" });
          dispatch({ type: "OPEN_COMPOSER" });
          break;
        case "view.process-panel":
          dispatch({ type: "TOGGLE_PROCESS_PANEL" });
          break;
        case "view.git-panel":
          if (toggleReviewDesk) toggleReviewDesk();
          else dispatch({ type: "TOGGLE_GIT_PANEL" });
          break;
        case "view.context-panel":
          dispatch({ type: "TOGGLE_CONTEXT" });
          break;
        case "view.search-panel":
          dispatch({ type: "TOGGLE_SEARCH_PANEL" });
          break;
        case "view.split-horizontal":
          dispatch({ type: "CLOSE_PALETTE" });
          if (focusedPaneId) {
            pendingSplit.current = { paneId: focusedPaneId, direction: "horizontal" };
            setSessionCreatorOpen({});
          }
          break;
        case "view.split-vertical":
          dispatch({ type: "CLOSE_PALETTE" });
          if (focusedPaneId) {
            pendingSplit.current = { paneId: focusedPaneId, direction: "vertical" };
            setSessionCreatorOpen({});
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
        case "help.check-update":
          onCheckForUpdates();
          break;
        case "help.website":
          open("https://hermes-ide.com");
          break;
        case "help.legal":
          open("https://hermes-ide.com/legal");
          break;
        case "help.report-bug": {
          const os = PLATFORM === "mac" ? "macOS" : PLATFORM === "win" ? "Windows" : "Linux";
          const params = new URLSearchParams({
            template: "bug_report.yml",
            version: __APP_VERSION__,
            os,
            "os-version": OS_VERSION,
          });
          open(`https://github.com/hermes-hq/hermes-ide/issues/new?${params}`);
          break;
        }
        case "help.shortcuts":
          dispatch({ type: "CLOSE_PALETTE" });
          setShortcutsOpen(true);
          break;
      }
    },
    [
      dispatch,
      createSession,
      createSessionAdvanced,
      createSessionDirect,
      activeSessionId,
      focusedPaneId,
      setSettingsOpen,
      setShortcutsOpen,
      setCostDashboardOpen,
      setSessionCreatorOpen,
      copyContextToClipboard,
      pendingSplit,
      requestCloseSession,
      onCheckForUpdates,
      commandPaletteShortcut,
      toggleReviewDesk,
    ],
  );

  useEffect(() => {
    ensureListener();
    const cleanup = registerMenuBarHandler(onMenuAction);
    return cleanup;
  }, [onMenuAction]);
}
