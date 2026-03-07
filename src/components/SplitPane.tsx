import "../styles/components/SplitPane.css";
import { useEffect, useRef, useState, useCallback } from "react";
import { useSession } from "../state/SessionContext";
import { ScopeBar } from "./ScopeBar";
import { ProviderActionsBar } from "./ProviderActionsBar";
import { TerminalPane } from "./TerminalPane";
import { focusTerminal, terminalHasSelection, terminalGetSelection, insertFilePaths } from "../terminal/TerminalPool";
import { SplitDirection, collectPanes } from "../state/layoutTypes";
import { useContextMenu, buildTerminalMenuItems, buildPaneHeaderMenuItems } from "../hooks/useContextMenu";
import { getCurrentWebview } from "@tauri-apps/api/webview";

// Use text/plain with a prefix so it works in all WebViews
const DRAG_PREFIX = "hermes-session:";

export function encodeSessionDrag(sessionId: string): string {
  return DRAG_PREFIX + sessionId;
}

export function decodeSessionDrag(data: string): string | null {
  if (data.startsWith(DRAG_PREFIX)) return data.slice(DRAG_PREFIX.length);
  return null;
}

// ── Shared drag state ──────────────────────────────────────────────
// SessionList sets this on dragstart; SplitPane reads it in the Tauri handler.
let _draggedSessionId: string | null = null;

export function setDraggedSession(id: string | null) {
  _draggedSessionId = id;
}

export function getDraggedSession(): string | null {
  return _draggedSessionId;
}

interface SplitPaneProps {
  paneId: string;
  sessionId: string;
}

type DropZone = "center" | "left" | "right" | "top" | "bottom" | null;

function computeDropZone(clientX: number, clientY: number, rect: DOMRect): DropZone {
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;

  // 25% edge zones
  if (x < 0.25 && y > 0.15 && y < 0.85) return "left";
  if (x > 0.75 && y > 0.15 && y < 0.85) return "right";
  if (y < 0.25 && x > 0.15 && x < 0.85) return "top";
  if (y > 0.75 && x > 0.15 && x < 0.85) return "bottom";

  // Corners — pick closest edge
  if (x < 0.5 && y < 0.5) return x < y ? "left" : "top";
  if (x > 0.5 && y < 0.5) return (1 - x) < y ? "right" : "top";
  if (x < 0.5 && y > 0.5) return x < (1 - y) ? "left" : "bottom";
  if (x > 0.5 && y > 0.5) return (1 - x) < (1 - y) ? "right" : "bottom";

  return "center";
}

export function SplitPane({ paneId, sessionId }: SplitPaneProps) {
  const { state, dispatch } = useSession();
  const session = state.sessions[sessionId];
  const isFocused = state.layout.focusedPaneId === paneId;
  const paneRef = useRef<HTMLDivElement>(null);
  const [dropZone, setDropZone] = useState<DropZone>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  // Keep refs for values used inside the Tauri handler to avoid re-registering
  const layoutRef = useRef(state.layout.root);
  layoutRef.current = state.layout.root;

  useEffect(() => {
    if (isFocused) focusTerminal(sessionId);
  }, [isFocused, sessionId]);

  // ── Tauri native drag-drop — handles BOTH session drags and OS file drags ──
  // With dragDropEnabled: true, Tauri intercepts all drags at the native level,
  // so HTML5 drag events don't fire reliably. We handle everything here.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let isFileDrag = false;
    // Capture the dragged session ID on enter — by the time "drop" fires,
    // SessionList's dragend cleanup may have already cleared the global.
    let capturedSessionId: string | null = null;

    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      const { type } = event.payload;

      if (type === "leave") {
        isFileDrag = false;
        capturedSessionId = null;
        setFileDragOver(false);
        setDropZone(null);
        return;
      }

      if (type === "enter") {
        isFileDrag = event.payload.paths.length > 0;
        capturedSessionId = _draggedSessionId;
      }

      const rect = paneRef.current?.getBoundingClientRect();
      if (!rect) return;

      const dpr = window.devicePixelRatio || 1;
      const x = event.payload.position.x / dpr;
      const y = event.payload.position.y / dpr;
      const isOver = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

      if (type === "enter" || type === "over") {
        if (isFileDrag) {
          setFileDragOver(isOver);
          setDropZone(null);
        } else if (capturedSessionId) {
          setFileDragOver(false);
          setDropZone(isOver ? computeDropZone(x, y, rect) : null);
        }
      } else if (type === "drop") {
        setFileDragOver(false);
        setDropZone(null);

        if (!isOver) { isFileDrag = false; capturedSessionId = null; return; }

        if (isFileDrag && event.payload.paths.length > 0) {
          // ── File drop → insert path(s) into terminal ──
          insertFilePaths(sessionId, event.payload.paths);
        } else if (capturedSessionId && capturedSessionId !== sessionId) {
          // ── Session drop → split/replace pane ──
          const droppedSessionId = capturedSessionId;

          // Prevent duplicate panes
          const root = layoutRef.current;
          if (root) {
            const existing = collectPanes(root).find((p) => p.sessionId === droppedSessionId);
            if (existing) {
              dispatch({ type: "FOCUS_PANE", paneId: existing.id });
              isFileDrag = false;
              return;
            }
          }

          const zone = computeDropZone(x, y, rect);
          if (zone === "center") {
            dispatch({ type: "SET_PANE_SESSION", paneId, sessionId: droppedSessionId });
          } else {
            const direction: SplitDirection =
              (zone === "left" || zone === "right") ? "horizontal" : "vertical";
            const insertBefore = zone === "left" || zone === "top";
            dispatch({
              type: "SPLIT_PANE",
              paneId,
              direction,
              newSessionId: droppedSessionId,
              insertBefore,
            });
          }
        }

        isFileDrag = false;
        capturedSessionId = null;
      }
    }).then((fn) => {
      if (cancelled) { fn(); } else { unlisten = fn; }
    });

    return () => { cancelled = true; unlisten?.(); };
  }, [sessionId, paneId, dispatch]);

  const handleMouseDown = useCallback(() => {
    if (!isFocused) {
      dispatch({ type: "FOCUS_PANE", paneId });
    } else {
      focusTerminal(sessionId);
    }
  }, [isFocused, paneId, sessionId, dispatch]);

  const hasSiblings = !!(state.layout.root && collectPanes(state.layout.root).length > 1);

  const handleTerminalAction = useCallback((actionId: string) => {
    switch (actionId) {
      case "terminal.copy": {
        const sel = terminalGetSelection(sessionId);
        if (sel) navigator.clipboard.writeText(sel).catch(console.error);
        break;
      }
      case "terminal.paste": document.execCommand("paste"); break;
      case "terminal.select-all": /* handled by terminal */ break;
      case "terminal.clear": /* TODO: wire to terminal clear */ break;
      case "terminal.split-right":
        dispatch({ type: "SPLIT_PANE", paneId, direction: "horizontal", newSessionId: sessionId });
        break;
      case "terminal.split-down":
        dispatch({ type: "SPLIT_PANE", paneId, direction: "vertical", newSessionId: sessionId });
        break;
    }
  }, [dispatch, paneId, sessionId]);

  const { showMenu: showTerminalMenu } = useContextMenu(handleTerminalAction);

  const handlePaneHeaderAction = useCallback((actionId: string) => {
    switch (actionId) {
      case "pane.split-right":
        dispatch({ type: "SPLIT_PANE", paneId, direction: "horizontal", newSessionId: sessionId });
        break;
      case "pane.split-down":
        dispatch({ type: "SPLIT_PANE", paneId, direction: "vertical", newSessionId: sessionId });
        break;
      case "pane.close":
        dispatch({ type: "CLOSE_PANE", paneId });
        break;
      case "pane.close-others":
        if (state.layout.root) {
          const allPanes = collectPanes(state.layout.root);
          for (const p of allPanes) {
            if (p.id !== paneId) dispatch({ type: "CLOSE_PANE", paneId: p.id });
          }
        }
        break;
    }
  }, [dispatch, paneId, sessionId, state.layout.root]);

  const { showMenu: showPaneMenu } = useContextMenu(handlePaneHeaderAction);

  if (!session) return null;

  return (
    <div
      ref={paneRef}
      className={`split-pane ${isFocused ? "split-pane-focused" : ""} ${dropZone || fileDragOver ? "split-pane-dragging" : ""}`}
      onMouseDown={handleMouseDown}
    >
      <div className="split-pane-header" onContextMenu={(e) => showPaneMenu(e, buildPaneHeaderMenuItems(paneId, hasSiblings))}>
        <div className="split-pane-label">
          <span className="split-pane-dot" style={{ background: session.color }} />
          <span>{session.label}</span>
          <span className="split-pane-phase">{session.phase}</span>
          <button
            className="split-pane-close"
            onClick={(e) => { e.stopPropagation(); dispatch({ type: "CLOSE_PANE", paneId }); }}
            title="Close pane"
          >&times;</button>
        </div>
        <ScopeBar sessionId={sessionId} />
        {(session.detected_agent || session.ai_provider) && (
          <ProviderActionsBar
            sessionId={sessionId}
            agentName={session.detected_agent?.name || session.ai_provider || ""}
            actions={session.metrics.available_actions}
            recentActions={session.metrics.recent_actions}
            phase={session.phase}
            aiProvider={session.ai_provider}
          />
        )}
      </div>
      <div className="split-pane-content">
        <div
          className="split-pane-terminal"
          onContextMenu={(e) => showTerminalMenu(e, buildTerminalMenuItems(terminalHasSelection(sessionId)))}
        >
          <TerminalPane sessionId={sessionId} phase={session.phase} color={session.color} />
        </div>
      </div>

      {/* Drag capture overlay — sits above xterm canvas during drags */}
      <div className="split-pane-drag-capture" />

      {/* Active drop zone highlight */}
      <div className={`split-pane-drop-overlay ${fileDragOver ? "split-pane-drop-center split-pane-drop-visible split-pane-drop-file" : dropZone ? `split-pane-drop-${dropZone} split-pane-drop-visible` : ""}`}>
        {(dropZone || fileDragOver) && (
          <div className="split-pane-drop-label">
            {fileDragOver ? "Drop to insert path" : dropZone === "center" ? "Replace" : `Split ${dropZone}`}
          </div>
        )}
      </div>
    </div>
  );
}
