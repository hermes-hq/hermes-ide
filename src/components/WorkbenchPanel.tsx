/**
 * Right-rail Workbench (v1.1.14, agent-mode only).
 *
 * Replaces the per-session-row folder icon and the legacy
 * AgentContextPanel as the primary right rail for agent sessions.
 * Ships with two tabs (Files, Context) and a per-session Notes
 * drawer pinned to the bottom.  Splitter between body and notes is
 * draggable; persisted ratio lives in `state.ui.workbench`.
 *
 * Design spec: docs/mockups/right-rail-workbench.html
 *
 * Render-gating: returns null for terminal-mode sessions.  The
 * activity bar / App.tsx layout takes care of hiding the column
 * entirely (no pixel-width budget) when the workbench is closed.
 */
import "../styles/components/WorkbenchPanel.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSession } from "../state/SessionContext";
import { FileExplorerPanel } from "./FileExplorerPanel";
import { AgentContextPanel } from "./AgentContextPanel";
import { GitPanel } from "./GitPanel";
import { WorkbenchNotes } from "./WorkbenchNotes";
import {
  clampFilesNotesSplit,
  MIN_FILES_NOTES_SPLIT,
  MAX_FILES_NOTES_SPLIT,
} from "../utils/workbenchLayout";
import type { SessionData } from "../types/session";

interface WorkbenchPanelProps {
  /** Active session.  The component is intended to mount only when
   *  this is an agent-mode session; it returns null otherwise so the
   *  caller can render unconditionally without checking. */
  session: SessionData | null;
}

export function WorkbenchPanel({ session }: WorkbenchPanelProps) {
  const { state, dispatch } = useSession();
  const wb = state.ui.workbench;
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Drag state for the internal Files↔Notes splitter.  Lives in a
  // ref so a 100hz pointermove storm doesn't trigger 100 reducer
  // dispatches; we coalesce to one dispatch per pointerup using rAF
  // for the visual update.
  const splitDragRef = useRef<{
    rect: DOMRect | null;
    nextRatio: number;
    rafId: number | null;
  } | null>(null);

  const onSplitPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    splitDragRef.current = {
      rect: panel.getBoundingClientRect(),
      nextRatio: wb.filesNotesSplit,
      rafId: null,
    };
    document.body.style.cursor = "ns-resize";
  }, [wb.filesNotesSplit]);

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const drag = splitDragRef.current;
      if (!drag || !drag.rect) return;
      const within = e.clientY - drag.rect.top;
      const total = drag.rect.height;
      if (total <= 0) return;
      // Files take the TOP portion.  Header (rough estimate) is
      // accounted for by clamping; the splitter itself sits at the
      // boundary so cursor.y - rect.top is the files height.
      const headerOffset = 60;
      const splitterY = within - headerOffset;
      const usable = total - headerOffset;
      const raw = usable > 0 ? splitterY / usable : drag.nextRatio;
      const clamped = clampFilesNotesSplit(raw);
      drag.nextRatio = clamped;
      if (drag.rafId !== null) return;
      drag.rafId = window.requestAnimationFrame(() => {
        const cur = splitDragRef.current;
        if (!cur) return;
        cur.rafId = null;
        // Visual update is achieved by dispatching — small enough
        // that a 60Hz dispatch is fine.  Reducer's no-op short-circuit
        // skips identical-ratio dispatches.
        dispatch({ type: "SET_WORKBENCH_FILES_NOTES_SPLIT", ratio: cur.nextRatio });
      });
    }
    function onPointerUp() {
      const drag = splitDragRef.current;
      if (!drag) return;
      if (drag.rafId !== null) window.cancelAnimationFrame(drag.rafId);
      // Final commit (already-dispatched ratio is fine; this is the
      // canonical place to land any cleanup work).
      dispatch({ type: "SET_WORKBENCH_FILES_NOTES_SPLIT", ratio: drag.nextRatio });
      splitDragRef.current = null;
      document.body.style.cursor = "";
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dispatch]);

  // External (chat ↔ workbench) resize handle.  Drag widens / narrows
  // the panel; clamping lives in the reducer (clampWorkbenchRatio).
  const widthDragRef = useRef<{
    startX: number;
    startWidth: number;
    rafId: number | null;
    nextRatio: number;
  } | null>(null);

  const onWidthPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    widthDragRef.current = {
      startX: e.clientX,
      startWidth: panel.offsetWidth,
      rafId: null,
      nextRatio: wb.ratio,
    };
    document.body.style.cursor = "col-resize";
  }, [wb.ratio]);

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      const drag = widthDragRef.current;
      if (!drag) return;
      // Right-rail: pointer moving LEFT widens the panel.
      const delta = drag.startX - e.clientX;
      const desired = drag.startWidth + delta;
      const viewport = window.innerWidth || 1440;
      drag.nextRatio = desired / viewport;
      if (drag.rafId !== null) return;
      drag.rafId = window.requestAnimationFrame(() => {
        const cur = widthDragRef.current;
        if (!cur) return;
        cur.rafId = null;
        dispatch({ type: "SET_WORKBENCH_RATIO", ratio: cur.nextRatio });
      });
    }
    function onPointerUp() {
      const drag = widthDragRef.current;
      if (!drag) return;
      if (drag.rafId !== null) window.cancelAnimationFrame(drag.rafId);
      dispatch({ type: "SET_WORKBENCH_RATIO", ratio: drag.nextRatio });
      widthDragRef.current = null;
      document.body.style.cursor = "";
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [dispatch]);

  const setTab = useCallback(
    (tab: "files" | "context" | "git") => {
      dispatch({ type: "SET_WORKBENCH_TAB", tab });
    },
    [dispatch],
  );

  const close = useCallback(() => {
    dispatch({ type: "SET_WORKBENCH_OPEN", open: false });
  }, [dispatch]);

  // Convert the Files↔Notes ratio to a CSS height for the notes row.
  // grid-template-rows is `auto 1fr 6px MIN(140px, var(--w-notes-h))`,
  // so the bottom row gets `(1 - filesRatio) * 100%`.  Clamp keeps it
  // out of pathological territory.
  const notesPct = useMemo(() => {
    const ratio = clampFilesNotesSplit(wb.filesNotesSplit);
    const pct = (1 - ratio) * 100;
    return `${pct.toFixed(2)}%`;
  }, [wb.filesNotesSplit]);

  // Render-gating: only agent sessions get the workbench.  Returning
  // null lets the caller mount unconditionally.
  if (!session || session.mode !== "agent") return null;
  if (!wb.open) return null;

  const sessionLabel = session.label || session.id.slice(0, 8);

  return (
    <aside
      ref={panelRef}
      className="workbench-panel"
      data-testid="workbench-panel"
      aria-label="Session workbench"
      style={{ "--workbench-notes-h": notesPct } as React.CSSProperties}
    >
      <div
        className="workbench-panel-external-handle"
        onPointerDown={onWidthPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize workbench"
      />

      <header className="workbench-head">
        <div className="workbench-title">
          <span className="workbench-session-pill">
            <span className="ledge" aria-hidden="true" />
            {sessionLabel}
          </span>
          <span className="workbench-scope">workbench</span>
          <button
            type="button"
            className="workbench-close"
            onClick={close}
            title="Close workbench (⌥⌘B)"
            aria-label="Close workbench"
          >
            ✕
          </button>
        </div>

        <div className="workbench-tabs" role="tablist">
          <button
            type="button"
            className="workbench-tab"
            role="tab"
            aria-selected={wb.tab === "files"}
            onClick={() => setTab("files")}
          >
            Files
          </button>
          <button
            type="button"
            className="workbench-tab"
            role="tab"
            aria-selected={wb.tab === "context"}
            onClick={() => setTab("context")}
          >
            Context
          </button>
          <button
            type="button"
            className="workbench-tab"
            role="tab"
            aria-selected={wb.tab === "git"}
            onClick={() => setTab("git")}
          >
            Git
          </button>
        </div>
      </header>

      {/* Both tab bodies are mounted; only the active one is visible.
          Keeping both in the DOM preserves scroll position and avoids
          re-running the embedded panel's heavy mount work on every
          tab switch.  The hidden attribute drops them out of layout. */}
      <div
        className="workbench-body"
        role="tabpanel"
        aria-label="Files"
        hidden={wb.tab !== "files"}
      >
        <FileExplorerPanel visible={wb.tab === "files"} />
      </div>
      <div
        className="workbench-body"
        role="tabpanel"
        aria-label="Context"
        hidden={wb.tab !== "context"}
      >
        <AgentContextPanel session={session} />
      </div>
      <div
        className="workbench-body"
        role="tabpanel"
        aria-label="Git"
        hidden={wb.tab !== "git"}
      >
        <GitPanel visible={wb.tab === "git"} />
      </div>

      <div
        className="workbench-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Files / Notes split"
        aria-valuemin={MIN_FILES_NOTES_SPLIT * 100}
        aria-valuemax={MAX_FILES_NOTES_SPLIT * 100}
        aria-valuenow={Math.round(wb.filesNotesSplit * 100)}
        onPointerDown={onSplitPointerDown}
      />

      <WorkbenchNotes session={session} />
    </aside>
  );
}
