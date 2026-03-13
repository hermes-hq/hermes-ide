import "../styles/components/SessionList.css";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { SessionData } from "../state/SessionContext";
import { updateSessionGroup, updateSessionLabel, updateSessionDescription, updateSessionColor, sshListTmuxWindows, sshTmuxSelectWindow, sshTmuxNewWindow, sshTmuxRenameWindow } from "../api/sessions";
import type { TmuxWindowEntry } from "../types/session";
import { encodeSessionDrag, setDraggedSession, getDraggedSession } from "./SplitPane";
// Note: HTML5 drag events don't fire in Tauri (dragDropEnabled: true intercepts them).
// We use getCurrentWebview().onDragDropEvent() with position-based hit testing instead.
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useContextMenu, buildSessionMenuItems, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";
import { fmt } from "../utils/platform";
import { useSessionGitSummary } from "../hooks/useSessionGitSummary";

export const SESSION_COLORS = [
  "#58a6ff", "#3fb950", "#bc8cff", "#f78166",
  "#39c5cf", "#d29922", "#f47067", "#d2a8ff",
  "#e06c75", "#e5c07b", "#56b6c2", "#c678dd",
];

export type SessionView = "git" | "files" | "search" | null;

interface SessionListProps {
  sessions: SessionData[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession?: (group?: string) => void;
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

/** Sub-component: tmux window tabs for SSH sessions with tmux attached. */
function TmuxWindowTabs({ session }: { session: SessionData }) {
  const [windows, setWindows] = useState<TmuxWindowEntry[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const refreshRef = useRef<() => void>(undefined);
  const info = session.ssh_info;

  // Refresh tmux windows periodically
  useEffect(() => {
    if (!info?.tmux_session || session.phase === "destroyed") return;

    let cancelled = false;
    const refresh = () => {
      sshListTmuxWindows(info.host, info.tmux_session!, info.port, info.user)
        .then((w) => { if (!cancelled) setWindows(w); })
        .catch(() => {});
    };
    refreshRef.current = refresh;

    refresh();
    const interval = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [info?.host, info?.port, info?.user, info?.tmux_session, session.phase]);

  if (!info?.tmux_session || session.phase === "destroyed" || windows.length === 0) return null;

  const handleSelectWindow = (index: number) => {
    // Optimistic: mark the clicked window as active immediately
    setWindows((prev) => prev.map((w) => ({ ...w, active: w.index === index })));
    sshTmuxSelectWindow(info.host, info.tmux_session!, index, info.port, info.user)
      .then(() => refreshRef.current?.())
      .catch((err) => { console.warn("[TmuxWindows] select failed:", err); refreshRef.current?.(); });
  };

  const handleNewWindow = () => {
    sshTmuxNewWindow(info.host, info.tmux_session!, info.port, info.user)
      .then(() => refreshRef.current?.())
      .catch((err) => console.warn("[TmuxWindows] new window failed:", err));
  };

  const handleRename = (index: number, name: string) => {
    if (!name.trim()) { setRenamingIndex(null); return; }
    // Optimistic update
    setWindows((prev) => prev.map((w) => w.index === index ? { ...w, name: name.trim() } : w));
    setRenamingIndex(null);
    sshTmuxRenameWindow(info.host, info.tmux_session!, index, name.trim(), info.port, info.user)
      .then(() => refreshRef.current?.())
      .catch((err) => { console.warn("[TmuxWindows] rename failed:", err); refreshRef.current?.(); });
  };

  return (
    <div className="tmux-windows">
      <div className="tmux-windows-header" onClick={() => setExpanded(!expanded)}>
        <span className="tmux-windows-chevron">{expanded ? "▾" : "▸"}</span>
        <span className="tmux-windows-label">tmux windows</span>
        <button
          className="tmux-windows-add"
          onClick={(e) => { e.stopPropagation(); handleNewWindow(); }}
          title="New tmux window"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" width="12" height="12">
            <line x1="8" y1="3" x2="8" y2="13" />
            <line x1="3" y1="8" x2="13" y2="8" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="tmux-windows-list">
          {windows.map((w) => (
            <div
              key={w.index}
              className={`tmux-window-item ${w.active ? "tmux-window-active" : ""}`}
              onClick={(e) => { e.stopPropagation(); handleSelectWindow(w.index); }}
              onDoubleClick={(e) => { e.stopPropagation(); setRenamingIndex(w.index); setRenameValue(w.name); }}
            >
              <span className="tmux-window-index">{w.index}</span>
              {renamingIndex === w.index ? (
                <input
                  className="tmux-window-rename-input"
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") handleRename(w.index, renameValue);
                    if (e.key === "Escape") setRenamingIndex(null);
                  }}
                  onBlur={() => handleRename(w.index, renameValue)}
                  autoComplete="off"
                  spellCheck={false}
                />
              ) : (
                <span className="tmux-window-name">{w.name}</span>
              )}
              {w.active && <span className="tmux-window-active-dot" />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Inline editable name field — activates on double-click or via ref trigger. */
function InlineNameEditor({ sessionId, label, triggerEdit, onTriggered }: { sessionId: string; label: string; triggerEdit: boolean; onTriggered?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (triggerEdit) {
      setEditing(true);
      setValue(label);
      onTriggered?.();
    }
  }, [triggerEdit, label, onTriggered]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    if (value.trim() && value.trim() !== label) {
      updateSessionLabel(sessionId, value.trim()).catch(console.error);
    }
  }, [sessionId, label, value]);

  if (!editing) {
    return (
      <div
        className="session-item-name session-item-editable"
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); setValue(label); }}
        title="Double-click to rename"
      >
        <span className="session-item-editable-text">{label}</span>
        <svg className="session-item-edit-icon" viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L3.463 11.1l-.47 1.642 1.643-.47 8.61-8.61a.25.25 0 0 0 0-.354l-1.086-1.086Z" />
        </svg>
      </div>
    );
  }

  return (
    <input
      ref={inputRef}
      className="session-item-name-input"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** Inline editable description — click to edit, shows placeholder when empty on active session. */
function InlineDescriptionEditor({ sessionId, description, isActive }: { sessionId: string; description: string; isActive: boolean }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.select();
      // Auto-size to content
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = textareaRef.current.scrollHeight + "px";
    }
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed !== description) {
      updateSessionDescription(sessionId, trimmed).catch(console.error);
    }
  }, [sessionId, description, value]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        className="session-item-description-input"
        value={value}
        autoFocus
        placeholder="Add description..."
        maxLength={120}
        rows={1}
        onChange={(e) => {
          setValue(e.target.value);
          // Auto-resize
          e.target.style.height = "auto";
          e.target.style.height = e.target.scrollHeight + "px";
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
          if (e.key === "Escape") { setValue(description); setEditing(false); }
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  if (description) {
    return (
      <div
        className="session-item-description"
        onClick={(e) => { e.stopPropagation(); setEditing(true); setValue(description); }}
        title="Click to edit description"
      >
        {description}
      </div>
    );
  }

  // Show placeholder only for the active session
  if (isActive) {
    return (
      <div
        className="session-item-description session-item-description-placeholder"
        onClick={(e) => { e.stopPropagation(); setEditing(true); setValue(""); }}
      >
        Add description...
      </div>
    );
  }

  return null;
}

/** Color picker popover — "None" + preset grid + custom hex input. Uses fixed positioning. */
function ColorPicker({
  currentColor,
  onSelect,
  onClose,
  anchorRef,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [customHex, setCustomHex] = useState("");

  useEffect(() => {
    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      const pickerHeight = 200;
      const top = Math.min(rect.top, window.innerHeight - pickerHeight - 8);
      setPos({ top, left: rect.right + 6 });
    }
  }, [anchorRef]);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleScroll = () => onClose();
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("scroll", handleScroll, true);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const isValidHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
  const applyCustom = () => {
    const hex = customHex.startsWith("#") ? customHex : `#${customHex}`;
    if (isValidHex(hex)) { onSelect(hex); onClose(); }
  };

  return (
    <div
      ref={ref}
      className="color-picker-popover"
      style={pos ? { top: pos.top, left: pos.left } : undefined}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className={`color-picker-none ${!currentColor ? "color-picker-none-active" : ""}`}
        onClick={() => { onSelect(""); onClose(); }}
      >
        None
      </button>
      <div className="color-picker-grid">
        {SESSION_COLORS.map((c) => (
          <button
            key={c}
            className={`color-picker-swatch ${c === currentColor ? "color-picker-swatch-active" : ""}`}
            style={{ background: c }}
            onClick={() => { onSelect(c); onClose(); }}
            title={c}
          />
        ))}
      </div>
      <div className="color-picker-custom">
        <input
          className="color-picker-hex-input"
          placeholder="#hex"
          value={customHex}
          maxLength={7}
          onChange={(e) => setCustomHex(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") applyCustom(); }}
        />
        {customHex && isValidHex(customHex.startsWith("#") ? customHex : `#${customHex}`) && (
          <div className="color-picker-custom-preview" style={{ background: customHex.startsWith("#") ? customHex : `#${customHex}` }} />
        )}
        <button
          className="color-picker-apply-btn"
          onClick={applyCustom}
          disabled={!isValidHex(customHex.startsWith("#") ? customHex : `#${customHex}`)}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

/** Inline editable project name — double-click to rename, same pattern as session names. */
function InlineProjectNameEditor({
  group,
  onRename,
}: {
  group: string;
  onRename: (oldName: string, newName: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(group);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== group) {
      onRename(group, trimmed);
    }
  }, [group, value, onRename]);

  if (!editing) {
    return (
      <span
        className="project-header-name project-header-name-editable"
        onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); setValue(group); }}
        title="Double-click to rename project"
      >
        {group}
        <svg className="project-header-edit-icon" viewBox="0 0 16 16" fill="currentColor" width="10" height="10">
          <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61Zm1.414 1.06a.25.25 0 0 0-.354 0L3.463 11.1l-.47 1.642 1.643-.47 8.61-8.61a.25.25 0 0 0 0-.354l-1.086-1.086Z" />
        </svg>
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className="project-header-name-input"
      value={value}
      autoFocus
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      onBlur={commit}
    />
  );
}

export function SessionList({ sessions, activeSessionId, onSelect, onClose, onNewSession, activeView, onViewChange, gitBadge }: SessionListProps) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [newGroupSessionId, setNewGroupSessionId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  // Empty projects that don't have sessions yet
  const [emptyProjects, setEmptyProjects] = useState<string[]>([]);
  // Color picker — can target a session OR a project group
  const [colorPickerSessionId, setColorPickerSessionId] = useState<string | null>(null);
  const [colorPickerGroup, setColorPickerGroup] = useState<string | null>(null);
  const colorPickerAnchorRef = useRef<HTMLElement | null>(null);
  // Move-to-project dropdown for a specific session
  const [moveSessionId, setMoveSessionId] = useState<string | null>(null);
  const [moveNewName, setMoveNewName] = useState("");
  const [showMoveNewInput, setShowMoveNewInput] = useState(false);

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
    // Include empty projects (no sessions yet)
    for (const ep of emptyProjects) {
      if (!map.has(ep)) {
        map.set(ep, []);
      }
    }
    const groups = Array.from(map.keys()).filter((g): g is string => g !== null).sort();
    return { grouped: map, allGroups: groups };
  }, [sessions, emptyProjects]);

  // Clean up empty project entries once they get sessions
  useEffect(() => {
    setEmptyProjects((prev) => {
      const sessionGroups = new Set(sessions.map((s) => s.group).filter(Boolean));
      const filtered = prev.filter((ep) => !sessionGroups.has(ep));
      return filtered.length !== prev.length ? filtered : prev;
    });
  }, [sessions]);

  const toggleGroup = useCallback((group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const handleRenameProject = useCallback((oldName: string, newName: string) => {
    // Rename a project = move all sessions from the old group to the new group
    const sessionsInGroup = sessions.filter((s) => s.group === oldName);
    if (sessionsInGroup.length === 0) {
      // Empty project — just rename in our local list
      setEmptyProjects((prev) => prev.map((p) => p === oldName ? newName : p));
    } else {
      for (const s of sessionsInGroup) {
        updateSessionGroup(s.id, newName).catch(console.error);
      }
    }
  }, [sessions]);

  // Store colors for empty projects (no sessions to hold the color)
  const [emptyProjectColors, setEmptyProjectColors] = useState<Record<string, string>>({});

  const handleProjectColorChange = useCallback((group: string, color: string) => {
    const sessionsInGroup = sessions.filter((s) => s.group === group);
    if (sessionsInGroup.length === 0) {
      // Empty project — store color locally
      setEmptyProjectColors((prev) => ({ ...prev, [group]: color }));
      return;
    }
    const count = sessionsInGroup.length;
    if (count > 1) {
      const msg = `Apply this color to all ${count} sessions in "${group}"?`;
      if (!window.confirm(msg)) return;
    }
    for (const s of sessionsInGroup) {
      updateSessionColor(s.id, color).catch(console.error);
    }
  }, [sessions]);

  const handleMoveToProject = useCallback((sessionId: string, targetGroup: string | null) => {
    updateSessionGroup(sessionId, targetGroup).catch(console.error);
    // If moving into a project, adopt the project's color
    if (targetGroup) {
      const projectSessions = sessions.filter((s) => s.group === targetGroup && s.id !== sessionId);
      const projectColor = projectSessions.find((s) => s.phase !== "destroyed")?.color;
      if (projectColor) {
        updateSessionColor(sessionId, projectColor).catch(console.error);
      }
    }
  }, [sessions]);

  const handleContextAction = useCallback((actionId: string) => {
    const sid = contextSessionRef.current;
    if (!sid) return;
    if (actionId === "session.rename") {
      setRenameSessionId(sid);
    } else if (actionId === "session.new-group") {
      setNewGroupSessionId(sid);
      setNewGroupName("");
    } else if (actionId === "session.remove-group") {
      handleMoveToProject(sid, null);
    } else if (actionId === "session.close") {
      onClose(sid);
    } else if (actionId.startsWith("session.set-group.")) {
      const group = actionId.replace("session.set-group.", "");
      handleMoveToProject(sid, group);
    }
  }, [onClose, handleMoveToProject]);

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

  // Keep a ref to sessions so the Tauri event listener can read current data
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Drag-and-drop between projects — uses Tauri native drag events
  // (HTML5 drag events don't fire because dragDropEnabled: true in tauri.conf.json)
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [isDraggingSession, setIsDraggingSession] = useState(false);
  const projectRefsMap = useRef<Map<string, HTMLElement>>(new Map());
  const ungroupedRef = useRef<HTMLDivElement>(null);

  const setProjectRef = useCallback((group: string, el: HTMLElement | null) => {
    if (el) projectRefsMap.current.set(group, el);
    else projectRefsMap.current.delete(group);
  }, []);

  // Tauri native drag-drop listener for project reordering
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let capturedSessionId: string | null = null;

    getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      const { type } = event.payload;

      // Only handle session drags (not file drags)
      if (type === "enter") {
        capturedSessionId = getDraggedSession();
        if (!capturedSessionId || event.payload.paths.length > 0) {
          capturedSessionId = null;
          return;
        }
        setIsDraggingSession(true);
      }

      if (!capturedSessionId) return;

      if (type === "leave") {
        capturedSessionId = null;
        setDropTarget(null);
        setIsDraggingSession(false);
        return;
      }

      const dpr = window.devicePixelRatio || 1;
      const x = event.payload.position.x / dpr;
      const y = event.payload.position.y / dpr;

      if (type === "over") {
        // Hit-test against project sections
        let found: string | null = null;
        for (const [group, el] of projectRefsMap.current) {
          const rect = el.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            found = group;
            break;
          }
        }
        // Hit-test ungrouped area
        if (!found && ungroupedRef.current) {
          const rect = ungroupedRef.current.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            found = "__ungrouped__";
          }
        }
        setDropTarget(found);
      } else if (type === "drop") {
        // Hit-test to find drop target
        let targetGroup: string | null | undefined = undefined;
        for (const [group, el] of projectRefsMap.current) {
          const rect = el.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            targetGroup = group;
            break;
          }
        }
        if (targetGroup === undefined && ungroupedRef.current) {
          const rect = ungroupedRef.current.getBoundingClientRect();
          if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            targetGroup = null; // ungrouped
          }
        }
        setDropTarget(null);
        setIsDraggingSession(false);

        if (targetGroup !== undefined && capturedSessionId) {
          const session = sessionsRef.current.find((s) => s.id === capturedSessionId);
          if (session && (session.group || null) !== targetGroup) {
            handleMoveToProject(capturedSessionId, targetGroup!);
          }
        }
        capturedSessionId = null;
      }
    }).then((fn) => { if (!cancelled) unlisten = fn; });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleMoveToProject]);

  const toggleView = useCallback((view: "git" | "files" | "search") => {
    onViewChange(activeView === view ? null : view);
  }, [activeView, onViewChange]);

  const renderSession = (session: SessionData) => {
    const isActive = session.id === activeSessionId;
    const shouldTriggerRename = renameSessionId === session.id;
    return (
      <div key={session.id} className={`session-item-wrapper${isActive ? " session-item-wrapper-active" : ""}`}>
        <div
          className={`session-item ${isActive ? "session-item-active" : ""} ${session.phase === "destroyed" ? "session-item-destroyed" : ""}`}
          draggable={session.phase !== "destroyed"}
          onDragStart={(e) => handleDragStart(e, session)}
          onClick={() => onSelect(session.id)}
          onContextMenu={(e) => handleContextMenu(e, session.id)}
        >
          <div
            className={`session-item-color-band ${!session.color ? "session-item-color-band-empty" : ""}`}
            style={{ background: session.phase === "destroyed" ? "var(--text-3)" : session.color || undefined }}
            onClick={(e) => {
              e.stopPropagation();
              const opening = colorPickerSessionId !== session.id;
              setColorPickerSessionId(opening ? session.id : null);
              setColorPickerGroup(null);
              if (opening) colorPickerAnchorRef.current = e.currentTarget as HTMLElement;
            }}
            title={session.color ? "Change color" : "Add color"}
          />
          {colorPickerSessionId === session.id && (
            <ColorPicker
              currentColor={session.color}
              onSelect={(color) => updateSessionColor(session.id, color).catch(console.error)}
              onClose={() => setColorPickerSessionId(null)}
              anchorRef={colorPickerAnchorRef}
            />
          )}
          <div className="session-item-info">
            <InlineNameEditor sessionId={session.id} label={session.label} triggerEdit={shouldTriggerRename} onTriggered={() => setRenameSessionId(null)} />
            <InlineDescriptionEditor sessionId={session.id} description={session.description} isActive={isActive} />
            <div className="session-item-meta">
              {session.ssh_info && (
                <span className="session-ssh-tag">SSH{session.ssh_info.tmux_session ? ` · ${session.ssh_info.tmux_session}` : ""}</span>
              )}
              {session.detected_agent && (
                <span className="session-agent-tag">{session.detected_agent.name}</span>
              )}
              <span className="session-phase-tag" data-phase={session.phase}>
                {session.phase === "busy" ? "working" : session.phase === "needs_input" ? "needs input" : session.phase === "shell_ready" ? "ready" : session.phase === "creating" ? "starting" : session.phase}
              </span>
              <span className="session-age">{timeAgo(session.last_activity_at)}</span>
            </div>
            <SessionItemGitInfo sessionId={session.id} isDestroyed={session.phase === "destroyed"} />
            {/* Inline project tag */}
            {session.phase !== "destroyed" && (
              <div className="session-item-project-row">
                {session.group ? (
                  <span
                    className="session-item-project-tag"
                    onClick={(e) => { e.stopPropagation(); setMoveSessionId(moveSessionId === session.id ? null : session.id); setShowMoveNewInput(false); }}
                    title="Click to change project"
                  >
                    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="10" height="10">
                      <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
                    </svg>
                    {session.group}
                  </span>
                ) : allGroups.length > 0 ? (
                  <button
                    className="session-item-project-assign"
                    onClick={(e) => { e.stopPropagation(); setMoveSessionId(moveSessionId === session.id ? null : session.id); setShowMoveNewInput(false); }}
                    title="Assign to a project"
                  >
                    + Project
                  </button>
                ) : null}
              </div>
            )}
          </div>
          <button
            className="session-item-close"
            onClick={(e) => { e.stopPropagation(); onClose(session.id); }}
            title="End session"
          >&times;</button>
        </div>
        {/* Tmux window tabs for SSH+tmux sessions */}
        {session.ssh_info?.tmux_session && isActive && (
          <TmuxWindowTabs session={session} />
        )}
        {/* Move-to-project dropdown */}
        {moveSessionId === session.id && (
          <div className="session-move-project-dropdown" onClick={(e) => e.stopPropagation()}>
            <button
              className={`session-move-project-option ${!session.group ? "active" : ""}`}
              onClick={() => { handleMoveToProject(session.id, null); setMoveSessionId(null); }}
            >
              No Project
            </button>
            {allGroups.map((g) => (
              <button
                key={g}
                className={`session-move-project-option ${session.group === g ? "active" : ""}`}
                onClick={() => { handleMoveToProject(session.id, g); setMoveSessionId(null); }}
              >
                <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="11" height="11">
                  <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
                </svg>
                {g}
              </button>
            ))}
            {!showMoveNewInput ? (
              <button
                className="session-move-project-option session-move-project-new"
                onClick={() => { setShowMoveNewInput(true); setMoveNewName(""); }}
              >
                + New Project
              </button>
            ) : (
              <input
                className="session-move-project-input"
                autoFocus
                placeholder="Project name..."
                value={moveNewName}
                onChange={(e) => setMoveNewName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && moveNewName.trim()) {
                    handleMoveToProject(session.id, moveNewName.trim());
                    setMoveSessionId(null);
                    setShowMoveNewInput(false);
                    setMoveNewName("");
                  }
                  if (e.key === "Escape") { setShowMoveNewInput(false); setMoveNewName(""); }
                }}
                onBlur={() => { setShowMoveNewInput(false); setMoveNewName(""); }}
              />
            )}
          </div>
        )}
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


  return (
    <div className="session-list">
      <div className="session-list-header">
        <span className="session-list-title">SESSIONS</span>
      </div>
      <div className="session-list-body" onContextMenu={handleEmptyAreaContextMenu}>
        {sessions.length === 0 && (
          <div className="session-list-empty">No active sessions<br/><span className="text-muted">Press {fmt("{mod}N")} to create one</span></div>
        )}

        {/* Projects (groups) first */}
        {allGroups.map((group) => {
          const groupSessions = grouped.get(group) || [];
          const isCollapsed = collapsedGroups.has(group);
          const groupCost = groupSessions.reduce((sum, s) => sum + sessionCost(s), 0);
          const groupColor = groupSessions.find((s) => s.phase !== "destroyed" && s.color)?.color || groupSessions.find((s) => s.color)?.color || emptyProjectColors[group] || "";

          return (
            <div
              key={group}
              ref={(el) => setProjectRef(group, el)}
              className={`project-section${dropTarget === group ? " project-section-drop-target" : ""}`}
            >
              <div
                className="project-header"
                role="button"
                tabIndex={0}
                onClick={() => toggleGroup(group)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup(group); } }}
              >
                <div
                  className={`project-header-color-band ${!groupColor ? "project-header-color-band-empty" : ""}`}
                  style={{ background: groupColor || undefined }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const opening = colorPickerGroup !== group;
                    setColorPickerGroup(opening ? group : null);
                    setColorPickerSessionId(null);
                    if (opening) colorPickerAnchorRef.current = e.currentTarget as HTMLElement;
                  }}
                  title="Change project color"
                />
                <div className="project-header-left">
                  <span className="project-header-chevron">{isCollapsed ? "▸" : "▾"}</span>
                  <svg className="project-header-icon" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                    <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
                  </svg>
                  <InlineProjectNameEditor group={group} onRename={handleRenameProject} />
                  <span className="project-header-count">{groupSessions.length}</span>
                </div>
                <div className="project-header-right">
                  {groupCost > 0 && (
                    <span className="project-header-cost">{formatCost(groupCost)}</span>
                  )}
                  <button
                    className="project-header-add-btn"
                    onClick={(e) => { e.stopPropagation(); onNewSession?.(group); }}
                    title="New session in this project"
                  >+</button>
                </div>
              </div>
              {colorPickerGroup === group && (
                <ColorPicker
                  currentColor={groupColor}
                  onSelect={(color) => handleProjectColorChange(group, color)}
                  onClose={() => setColorPickerGroup(null)}
                  anchorRef={colorPickerAnchorRef}
                />
              )}
              {!isCollapsed && (
                <div className="project-sessions">
                  {groupSessions.map((session) => {
                    return renderSession(session);
                  })}
                </div>
              )}
            </div>
          );
        })}

        {/* Ungrouped sessions at bottom */}
        <div
          ref={ungroupedRef}
          className={`ungrouped-section${dropTarget === "__ungrouped__" ? " ungrouped-section-drop-target" : ""}${isDraggingSession && allGroups.length > 0 ? " ungrouped-section-drag-active" : ""}`}
        >
          {((grouped.get(null) || []).length > 0 || (isDraggingSession && allGroups.length > 0)) && (
            <div className="ungrouped-divider">
              <span>{dropTarget === "__ungrouped__" ? "Drop here to remove from project" : "Ungrouped"}</span>
            </div>
          )}
          {(grouped.get(null) || []).map((session) => {
            return renderSession(session);
          })}
        </div>
      </div>

      {/* Sidebar footer: New Project button + inline input */}
      <div className="session-list-footer">
        {newGroupSessionId ? (
          <div className="session-list-new-project-input">
            <input
              autoFocus
              placeholder="Project name..."
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newGroupName.trim()) {
                  const name = newGroupName.trim();
                  if (newGroupSessionId === "__global__") {
                    // Create an empty project (no session to assign)
                    setEmptyProjects((prev) => prev.includes(name) ? prev : [...prev, name]);
                  } else {
                    updateSessionGroup(newGroupSessionId, name).catch(console.error);
                  }
                  setNewGroupSessionId(null);
                }
                if (e.key === "Escape") setNewGroupSessionId(null);
              }}
              onBlur={() => {
                // On blur, also create the project if name is filled
                if (newGroupName.trim() && newGroupSessionId === "__global__") {
                  const name = newGroupName.trim();
                  setEmptyProjects((prev) => prev.includes(name) ? prev : [...prev, name]);
                }
                setNewGroupSessionId(null);
              }}
            />
          </div>
        ) : (
          <button
            className="session-list-new-project-btn"
            onClick={() => { setNewGroupSessionId("__global__"); setNewGroupName(""); }}
          >
            <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
              <path d="M2 5C2 3.9 2.9 3 4 3H7L9 5H14C15.1 5 16 5.9 16 7V13C16 14.1 15.1 15 14 15H4C2.9 15 2 14.1 2 13V5Z" />
            </svg>
            New Project
          </button>
        )}
      </div>
    </div>
  );
}
