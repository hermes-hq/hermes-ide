import "../styles/components/SessionList.css";
import { useState, useEffect, useCallback, useRef } from "react";

interface SessionContextMenuProps {
  x: number;
  y: number;
  sessionId: string;
  currentGroup: string | null;
  allGroups: string[];
  onSetGroup: (group: string | null) => void;
  onRename: (newLabel: string) => void;
  onClose: () => void;
}

export function SessionContextMenu({ x, y, currentGroup, allGroups, onSetGroup, onRename, onClose }: SessionContextMenuProps) {
  const [showNewInput, setShowNewInput] = useState(false);
  const [showRenameInput, setShowRenameInput] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const handleNewGroup = useCallback(() => {
    if (newGroupName.trim()) {
      onSetGroup(newGroupName.trim());
      onClose();
    }
  }, [newGroupName, onSetGroup, onClose]);

  const handleRename = useCallback(() => {
    if (renameValue.trim()) {
      onRename(renameValue.trim());
      onClose();
    }
  }, [renameValue, onRename, onClose]);

  return (
    <div className="session-context-menu" ref={menuRef} style={{ left: x, top: y }}>
      {/* Rename */}
      {showRenameInput ? (
        <div className="session-context-menu-input-row">
          <input
            className="session-context-menu-input"
            placeholder="New name..."
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleRename(); }}
            autoFocus
          />
        </div>
      ) : (
        <div
          className="session-context-menu-item"
          onClick={() => setShowRenameInput(true)}
        >
          Rename...
        </div>
      )}

      <div className="session-context-menu-divider" />

      {/* Groups */}
      {allGroups.map((group) => (
        <div
          key={group}
          className={`session-context-menu-item ${currentGroup === group ? "text-green" : ""}`}
          onClick={() => { onSetGroup(group); onClose(); }}
        >
          {group}
        </div>
      ))}
      {allGroups.length > 0 && <div className="session-context-menu-divider" />}
      {showNewInput ? (
        <div className="session-context-menu-input-row">
          <input
            className="session-context-menu-input"
            placeholder="Group name..."
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleNewGroup(); }}
            autoFocus
          />
        </div>
      ) : (
        <div
          className="session-context-menu-item"
          onClick={() => setShowNewInput(true)}
        >
          New group...
        </div>
      )}
      {currentGroup && (
        <>
          <div className="session-context-menu-divider" />
          <div
            className="session-context-menu-item text-red"
            onClick={() => { onSetGroup(null); onClose(); }}
          >
            Remove from group
          </div>
        </>
      )}
    </div>
  );
}
