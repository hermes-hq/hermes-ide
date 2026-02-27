import "../styles/components/SessionList.css";
import { useState, useMemo, useCallback, useRef } from "react";
import { SessionData } from "../state/SessionContext";
import { updateSessionGroup, updateSessionLabel } from "../api/sessions";
import { encodeSessionDrag } from "./SplitPane";
import { useContextMenu, buildSessionMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";

interface SessionListProps {
  sessions: SessionData[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession?: () => void;
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  return `${Math.floor(diffHr / 24)}d`;
}

function formatCost(n: number): string {
  if (n === 0) return "";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function sessionCost(session: SessionData): number {
  let cost = 0;
  for (const t of Object.values(session.metrics.token_usage)) {
    cost += t.estimated_cost_usd;
  }
  return cost;
}

// Sort: active sessions first (idle/busy/etc.), destroyed at bottom
function sortSessions(sessions: SessionData[]): SessionData[] {
  return [...sessions].sort((a, b) => {
    const aDestroyed = a.phase === "destroyed" ? 1 : 0;
    const bDestroyed = b.phase === "destroyed" ? 1 : 0;
    if (aDestroyed !== bDestroyed) return aDestroyed - bDestroyed;
    return 0; // preserve original order within same group
  });
}

export function SessionList({ sessions, activeSessionId, onSelect, onClose, onNewSession }: SessionListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [newGroupSessionId, setNewGroupSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [newGroupName, setNewGroupName] = useState("");

  // Track which session was right-clicked for action handlers
  const contextSessionRef = useRef<string | null>(null);

  const { grouped, allGroups } = useMemo(() => {
    const map = new Map<string | null, SessionData[]>();
    for (const session of sessions) {
      const group = session.group || null;
      const list = map.get(group) || [];
      list.push(session);
      map.set(group, list);
    }
    // Sort within each group: destroyed at bottom
    for (const [key, list] of map) {
      map.set(key, sortSessions(list));
    }
    const groups = Array.from(map.keys()).filter((g): g is string => g !== null).sort();
    return { grouped: map, allGroups: groups };
  }, [sessions]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const handleContextAction = useCallback((actionId: string) => {
    const sid = contextSessionRef.current;
    if (!sid) return;
    if (actionId === "session.rename") {
      setRenameSessionId(sid);
      setRenameValue("");
    } else if (actionId === "session.new-group") {
      setNewGroupSessionId(sid);
      setNewGroupName("");
    } else if (actionId === "session.remove-group") {
      updateSessionGroup(sid, null).catch(console.error);
    } else if (actionId === "session.duplicate") {
      // Handled by parent via dispatch
    } else if (actionId === "session.close") {
      onClose(sid);
    } else if (actionId.startsWith("session.set-group.")) {
      const group = actionId.replace("session.set-group.", "");
      updateSessionGroup(sid, group).catch(console.error);
    }
  }, [onClose]);

  const { showMenu } = useContextMenu(handleContextAction);

  const handleEmptyAreaAction = useCallback((actionId: string) => {
    if (actionId === "empty.new-session") {
      onNewSession?.();
    }
  }, [onNewSession]);

  const { showMenu: showEmptyMenu } = useContextMenu(handleEmptyAreaAction);

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    contextSessionRef.current = sessionId;
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const items = buildSessionMenuItems(
      { id: session.id, group: session.group || null, phase: session.phase },
      allGroups,
    );
    showMenu(e, items);
  }, [sessions, allGroups, showMenu]);

  const handleEmptyAreaContextMenu = useCallback((e: React.MouseEvent) => {
    showEmptyMenu(e, buildEmptyAreaMenuItems("sidebar"));
  }, [showEmptyMenu]);

  const handleDragStart = useCallback((e: React.DragEvent, session: SessionData) => {
    e.dataTransfer.setData("text/plain", encodeSessionDrag(session.id));
    e.dataTransfer.effectAllowed = "move";
    // Activate all pane drag-capture overlays so xterm canvas doesn't eat events
    document.body.classList.add("session-dragging");
    const cleanup = () => {
      document.body.classList.remove("session-dragging");
      window.removeEventListener("dragend", cleanup);
      window.removeEventListener("drop", cleanup);
    };
    window.addEventListener("dragend", cleanup);
    window.addEventListener("drop", cleanup);
    // Create custom drag ghost
    const ghost = document.createElement("div");
    ghost.textContent = session.label;
    ghost.style.cssText = `
      padding: 4px 10px;
      background: var(--bg-2, #1a222d);
      color: var(--text-0, #c8d6e5);
      border: 1px solid var(--border, #1a2332);
      border-radius: 4px;
      font-size: 12px;
      font-family: monospace;
      position: absolute;
      top: -1000px;
    `;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    requestAnimationFrame(() => ghost.remove());
  }, []);

  const renderSession = (session: SessionData, idx: number) => (
    <div
      key={session.id}
      className={`session-item ${session.id === activeSessionId ? "session-item-active" : ""} ${session.phase === "destroyed" ? "session-item-destroyed" : ""}`}
      draggable={session.phase !== "destroyed"}
      onDragStart={(e) => handleDragStart(e, session)}
      onClick={() => onSelect(session.id)}
      onContextMenu={(e) => handleContextMenu(e, session.id)}
    >
      <div className="session-item-indicator">
        <span className="session-color-dot" style={{ background: session.phase === "destroyed" ? "var(--text-3)" : session.color }} />
        <span className="session-number">{idx < 9 ? idx + 1 : ""}</span>
      </div>
      <div className="session-item-info">
        <div className="session-item-name">{session.label}</div>
        <div className="session-item-meta">
          {session.detected_agent && (
            <span className="session-agent-tag">{session.detected_agent.name}</span>
          )}
          <span className="session-phase-tag" data-phase={session.phase}>
            {session.phase === "busy" ? "working" : session.phase === "shell_ready" ? "ready" : session.phase === "creating" ? "starting" : session.phase}
          </span>
          <span className="session-age">{timeAgo(session.last_activity_at)}</span>
        </div>
      </div>
      <button
        className="session-item-close"
        onClick={(e) => { e.stopPropagation(); onClose(session.id); }}
        title="End session"
      >&times;</button>
    </div>
  );

  // Pre-compute session index map for keyboard shortcuts (concurrent-mode safe)
  const sessionIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    for (const session of (grouped.get(null) || [])) {
      map.set(session.id, idx++);
    }
    for (const group of allGroups) {
      if (!collapsedGroups.has(group)) {
        for (const session of (grouped.get(group) || [])) {
          map.set(session.id, idx++);
        }
      }
    }
    return map;
  }, [grouped, allGroups, collapsedGroups]);

  return (
    <div className="session-list">
      <div className="session-list-header">
        <span className="session-list-title">SESSIONS</span>
      </div>
      <div className="session-list-body" onContextMenu={handleEmptyAreaContextMenu}>
        {sessions.length === 0 && (
          <div className="session-list-empty">No active sessions<br/><span className="text-muted">Press ⌘N to create one</span></div>
        )}

        {/* Ungrouped sessions first */}
        {(grouped.get(null) || []).map((session) => {
          return renderSession(session, sessionIndexMap.get(session.id) ?? 0);
        })}

        {/* Grouped sessions */}
        {allGroups.map((group) => {
          const groupSessions = grouped.get(group) || [];
          const isCollapsed = collapsedGroups.has(group);
          const groupCost = groupSessions.reduce((sum, s) => sum + sessionCost(s), 0);

          return (
            <div key={group}>
              <div
                className="session-group-header"
                role="button"
                tabIndex={0}
                onClick={() => toggleGroup(group)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup(group); } }}
              >
                <span>
                  {isCollapsed ? "▸" : "▾"} {group} ({groupSessions.length})
                </span>
                {groupCost > 0 && (
                  <span className="session-group-cost">{formatCost(groupCost)}</span>
                )}
              </div>
              {!isCollapsed && groupSessions.map((session) => {
                return renderSession(session, sessionIndexMap.get(session.id) ?? 0);
              })}
            </div>
          );
        })}
      </div>

      {/* Inline rename input (appears after native popup "Rename..." action) */}
      {renameSessionId && (
        <div className="session-inline-input-overlay" onClick={() => setRenameSessionId(null)}>
          <div className="session-inline-input" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="New name..."
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameValue.trim()) {
                  updateSessionLabel(renameSessionId, renameValue.trim()).catch(console.error);
                  setRenameSessionId(null);
                }
                if (e.key === "Escape") setRenameSessionId(null);
              }}
            />
          </div>
        </div>
      )}
      {/* Inline new group input */}
      {newGroupSessionId && (
        <div className="session-inline-input-overlay" onClick={() => setNewGroupSessionId(null)}>
          <div className="session-inline-input" onClick={(e) => e.stopPropagation()}>
            <input
              autoFocus
              placeholder="Group name..."
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newGroupName.trim()) {
                  updateSessionGroup(newGroupSessionId, newGroupName.trim()).catch(console.error);
                  setNewGroupSessionId(null);
                }
                if (e.key === "Escape") setNewGroupSessionId(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
