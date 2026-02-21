import { useEffect, useRef, useState, useCallback } from "react";
import { useSession } from "../state/SessionContext";
import { ScopeBar } from "./ScopeBar";
import { ProviderActionsBar } from "./ProviderActionsBar";
import { TerminalPane } from "./TerminalPane";
import { focusTerminal } from "../terminal/TerminalPool";
import { SplitDirection, collectPanes } from "../state/layoutTypes";

// Use text/plain with a prefix so it works in all WebViews
const DRAG_PREFIX = "hermes-session:";

export function encodeSessionDrag(sessionId: string): string {
  return DRAG_PREFIX + sessionId;
}

export function decodeSessionDrag(data: string): string | null {
  if (data.startsWith(DRAG_PREFIX)) return data.slice(DRAG_PREFIX.length);
  return null;
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
  const dragCounterRef = useRef(0);

  useEffect(() => {
    if (isFocused) focusTerminal(sessionId);
  }, [isFocused, sessionId]);

  const handleMouseDown = useCallback(() => {
    if (!isFocused) {
      dispatch({ type: "FOCUS_PANE", paneId });
    } else {
      // Pane already focused in React state, but xterm may have lost DOM focus
      // (e.g. after a system dialog stole focus). Re-focus it.
      focusTerminal(sessionId);
    }
  }, [isFocused, paneId, sessionId, dispatch]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    if (paneRef.current) {
      setDropZone(computeDropZone(e.clientX, e.clientY, paneRef.current.getBoundingClientRect()));
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (paneRef.current) {
      setDropZone(computeDropZone(e.clientX, e.clientY, paneRef.current.getBoundingClientRect()));
    }
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDropZone(null);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setDropZone(null);

      const raw = e.dataTransfer.getData("text/plain");
      const droppedSessionId = decodeSessionDrag(raw);
      if (!droppedSessionId || droppedSessionId === sessionId) return;

      // Prevent duplicate panes: if a pane already shows this session, focus it instead
      if (state.layout.root) {
        const existing = collectPanes(state.layout.root).find((p) => p.sessionId === droppedSessionId);
        if (existing) {
          dispatch({ type: "FOCUS_PANE", paneId: existing.id });
          return;
        }
      }

      const zone = paneRef.current
        ? computeDropZone(e.clientX, e.clientY, paneRef.current.getBoundingClientRect())
        : "center";

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
    },
    [paneId, sessionId, dispatch, state.layout.root],
  );

  if (!session) return null;

  return (
    <div
      ref={paneRef}
      className={`split-pane ${isFocused ? "split-pane-focused" : ""} ${dropZone ? "split-pane-dragging" : ""}`}
      onMouseDown={handleMouseDown}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="split-pane-header">
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
      <div className="split-pane-terminal">
        <TerminalPane sessionId={sessionId} phase={session.phase} color={session.color} />
      </div>

      {/* Drag capture overlay — sits above xterm canvas during drags */}
      <div className="split-pane-drag-capture" />

      {/* Active drop zone highlight */}
      <div className={`split-pane-drop-overlay ${dropZone ? `split-pane-drop-${dropZone} split-pane-drop-visible` : ""}`}>
        {dropZone && (
          <div className="split-pane-drop-label">
            {dropZone === "center" ? "Replace" : `Split ${dropZone}`}
          </div>
        )}
      </div>
    </div>
  );
}
