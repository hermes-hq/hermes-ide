import "../styles/components/SessionList.css";
import { useState, useMemo, useCallback, useRef } from "react";
import { SessionData } from "../state/SessionContext";
import { updateSessionGroup, updateSessionLabel } from "../api/sessions";
import { encodeSessionDrag, setDraggedSession } from "./SplitPane";
import { useContextMenu, buildSessionMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";
import { fmt } from "../utils/platform";
import { useSessionGitSummary } from "../hooks/useSessionGitSummary";

export type SessionView = "git" | "files" | "search" | null;

interface SessionListProps {
  sessions: SessionData[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession?: () => void;
  /** Currently active sub-view panel for the active session */
  activeView: SessionView;
  onViewChange: (view: SessionView) => void;
  /** Number of git changes for the active session */
  gitBadge?: number;
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

/** Sub-component: git branch + change summary for a session item. */
function SessionItemGitInfo({ sessionId, isDestroyed }: { sessionId: string; isDestroyed: boolean }) {
  const { branch, changeCount, ahead, behind, hasConflicts, isLoading } = useSessionGitSummary(
    sessionId,
    !isDestroyed,
  );

  if (isDestroyed || isLoading || !branch) return null;

  return (
    <div className="session-item-git">
      <span className="session-item-git-branch">
        <svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10" aria-hidden="true">
          <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
        </svg>
        {branch}
      </span>
      <span className="session-item-git-dot">&middot;</span>
      {hasConflicts ? (
        <span className="session-item-git-status session-item-git-conflicts">conflicts</span>
      ) : changeCount > 0 ? (
        <span className="session-item-git-status">{changeCount} {changeCount === 1 ? "change" : "changes"}</span>
      ) : (
        <span className="session-item-git-status session-item-git-clean">clean</span>
      )}
      {(ahead > 0 || behind > 0) && (
        <span className="session-item-git-ahead-behind">
          {ahead > 0 && `↑${ahead}`}{ahead > 0 && behind > 0 && " "}{behind > 0 && `↓${behind}`}
        </span>
      )}
    </div>
  );
}

export function SessionList({ sessions, activeSessionId, onSelect, onClose, onNewSession, activeView, onViewChange, gitBadge }: SessionListProps) {
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
    // Share dragged session ID with SplitPane's Tauri drag handler
    setDraggedSession(session.id);
    // Activate all pane drag-capture overlays so xterm canvas doesn't eat events
    document.body.classList.add("session-dragging");
    const cleanup = () => {
      setDraggedSession(null);
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

  const toggleView = useCallback((view: "git" | "files" | "search") => {
    onViewChange(activeView === view ? null : view);
  }, [activeView, onViewChange]);

  const renderSession = (session: SessionData, idx: number) => {
    const isActive = session.id === activeSessionId;
    return (
      <div key={session.id} className={`session-item-wrapper${isActive ? " session-item-wrapper-active" : ""}`}>
        <div
          className={`session-item ${isActive ? "session-item-active" : ""} ${session.phase === "destroyed" ? "session-item-destroyed" : ""}`}
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
            <SessionItemGitInfo sessionId={session.id} isDestroyed={session.phase === "destroyed"} />
          </div>
          <button
            className="session-item-close"
            onClick={(e) => { e.stopPropagation(); onClose(session.id); }}
            title="End session"
          >&times;</button>
        </div>
        {/* Sub-view toolbar — only shown for the active session */}
        {isActive && session.phase !== "destroyed" && (
          <div className="session-subviews">
            {([
              { id: "git" as const, title: "Git", badge: gitBadge, icon: (
                <svg viewBox="0 0 16 16" fill="currentColor" width="14" height="14">
                  <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                </svg>
              )},
              { id: "files" as const, title: "Files", icon: (
                <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
                </svg>
              )},
              { id: "search" as const, title: "Search", icon: (
                <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <circle cx="7.5" cy="7.5" r="5" />
                  <line x1="11" y1="11" x2="15.5" y2="15.5" />
                </svg>
              )},
            ]).map((item) => (
              <button
                key={item.id}
                className={`session-subview-btn${activeView === item.id ? " session-subview-active" : ""}`}
                onClick={() => toggleView(item.id)}
                title={item.title}
              >
                {item.icon}
                {item.badge != null && item.badge > 0 && (
                  <span className="session-subview-badge">{item.badge}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

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
          <div className="session-list-empty">No active sessions<br/><span className="text-muted">Press {fmt("{mod}N")} to create one</span></div>
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
