/**
 * HERMES DEBUG PANEL — Floating diagnostic overlay
 *
 * Shows live event stream, filterable by session and category.
 * Export to JSON. Only visible when HERMES_DEBUG is active.
 */

import { useState, useEffect, useRef, useCallback, memo } from "react";
import {
  HERMES_DEBUG,
  HERMES_RAW_MODE,
  subscribe,
  getEvents,
  clearEvents,
  exportEventsJSON,
  type DiagnosticEvent,
  type EventCategory,
} from "./eventRecorder";

const CATEGORY_COLORS: Record<EventCategory, string> = {
  INPUT: "#ff9800",
  TERMINAL: "#4caf50",
  PTY: "#2196f3",
  CONTEXT: "#e91e63",
  SHORTCUT: "#9c27b0",
  MOUNT: "#00bcd4",
  WINDOW: "#795548",
};

const EventRow = memo(function EventRow({ event }: { event: DiagnosticEvent }) {
  const color = CATEGORY_COLORS[event.category] || "#888";
  return (
    <div style={{
      fontFamily: "monospace",
      fontSize: 11,
      lineHeight: "16px",
      padding: "1px 4px",
      borderBottom: "1px solid rgba(255,255,255,0.05)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    }}>
      <span style={{ color: "#666", marginRight: 4 }}>#{event.seq}</span>
      <span style={{ color: "#888", marginRight: 4 }}>{event.ts.toFixed(1)}ms</span>
      <span style={{ color, fontWeight: "bold", marginRight: 4 }}>{event.category}</span>
      <span style={{ color: "#ccc", marginRight: 4 }}>{event.event}</span>
      <span style={{ color: "#666", marginRight: 4 }}>s={event.sessionId.slice(0, 8)}</span>
      {event.charCodes && (
        <span style={{ color: "#ff5722", marginRight: 4 }}>
          [{event.charCodes.map(c => "0x" + c.toString(16)).join(",")}]
        </span>
      )}
      <span style={{ color: "#aaa" }}>{event.payload.slice(0, 80)}</span>
    </div>
  );
});

export function DebugPanel() {
  if (!HERMES_DEBUG) return null;

  const [visible, setVisible] = useState(false);
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [filterSession, setFilterSession] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<EventCategory | "">("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 10, y: 10 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0, px: 0, py: 0 });

  // Subscribe to live events
  useEffect(() => {
    if (!visible) return;
    // Load existing events
    setEvents([...getEvents()]);

    const unsub = subscribe((event) => {
      setEvents(prev => {
        const next = [...prev, event];
        if (next.length > 2000) next.splice(0, next.length - 2000);
        return next;
      });
    });
    return unsub;
  }, [visible]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const handleExport = useCallback(() => {
    const json = exportEventsJSON();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hermes-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleClear = useCallback(() => {
    clearEvents();
    setEvents([]);
  }, []);

  // Dragging
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === "BUTTON" ||
        (e.target as HTMLElement).tagName === "SELECT" ||
        (e.target as HTMLElement).tagName === "INPUT") return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY, px: position.x, py: position.y };
  }, [position]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setPosition({ x: dragStart.current.px + dx, y: dragStart.current.py + dy });
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // Filter events
  const filtered = events.filter(e => {
    if (filterSession && !e.sessionId.includes(filterSession)) return false;
    if (filterCategory && e.category !== filterCategory) return false;
    return true;
  });

  // Unique sessions for filter
  const sessions = [...new Set(events.map(e => e.sessionId))];

  // Toggle button (always visible)
  if (!visible) {
    return (
      <button
        onClick={() => setVisible(true)}
        style={{
          position: "fixed",
          bottom: 8,
          right: 8,
          zIndex: 99999,
          background: "#ff5722",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          padding: "4px 8px",
          fontSize: 11,
          fontFamily: "monospace",
          cursor: "pointer",
          opacity: 0.8,
        }}
      >
        DBG{HERMES_RAW_MODE ? " [RAW]" : ""} ({getEvents().length})
      </button>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        left: position.x,
        top: position.y,
        width: 700,
        height: 400,
        zIndex: 99999,
        background: "rgba(0,0,0,0.92)",
        border: "1px solid #333",
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
        userSelect: dragging ? "none" : "auto",
      }}
    >
      {/* Header (draggable) */}
      <div
        onMouseDown={onMouseDown}
        style={{
          padding: "4px 8px",
          background: "#1a1a1a",
          borderBottom: "1px solid #333",
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "move",
          flexShrink: 0,
        }}
      >
        <span style={{ color: "#ff5722", fontWeight: "bold", fontFamily: "monospace", fontSize: 12 }}>
          HERMES DEBUG{HERMES_RAW_MODE ? " [RAW]" : ""}
        </span>
        <span style={{ color: "#666", fontFamily: "monospace", fontSize: 11 }}>
          {filtered.length}/{events.length} events
        </span>

        <select
          value={filterSession}
          onChange={e => setFilterSession(e.target.value)}
          style={{ marginLeft: "auto", background: "#222", color: "#ccc", border: "1px solid #444", fontSize: 11, borderRadius: 3 }}
        >
          <option value="">All sessions</option>
          {sessions.map(s => <option key={s} value={s}>{s.slice(0, 12)}</option>)}
        </select>

        <select
          value={filterCategory}
          onChange={e => setFilterCategory(e.target.value as EventCategory | "")}
          style={{ background: "#222", color: "#ccc", border: "1px solid #444", fontSize: 11, borderRadius: 3 }}
        >
          <option value="">All categories</option>
          <option value="INPUT">INPUT</option>
          <option value="TERMINAL">TERMINAL</option>
          <option value="PTY">PTY</option>
          <option value="CONTEXT">CONTEXT</option>
          <option value="SHORTCUT">SHORTCUT</option>
          <option value="MOUNT">MOUNT</option>
          <option value="WINDOW">WINDOW</option>
        </select>

        <label style={{ color: "#888", fontSize: 11, fontFamily: "monospace", display: "flex", alignItems: "center", gap: 2 }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          scroll
        </label>

        <button onClick={handleExport} style={{ background: "#333", color: "#ccc", border: "none", borderRadius: 3, padding: "2px 6px", fontSize: 11, cursor: "pointer" }}>Export</button>
        <button onClick={handleClear} style={{ background: "#333", color: "#ccc", border: "none", borderRadius: 3, padding: "2px 6px", fontSize: 11, cursor: "pointer" }}>Clear</button>
        <button onClick={() => setVisible(false)} style={{ background: "#333", color: "#f44", border: "none", borderRadius: 3, padding: "2px 6px", fontSize: 11, cursor: "pointer" }}>X</button>
      </div>

      {/* Event stream */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {filtered.map(e => <EventRow key={e.seq} event={e} />)}
      </div>
    </div>
  );
}
