import { useState, useEffect, useRef, useMemo } from "react";
import { SessionData } from "../state/SessionContext";

interface CommandPaletteProps {
  onClose: () => void;
  sessions: SessionData[];
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onToggleContext: () => void;
  onToggleSessions: () => void;
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  onOpenCostDashboard?: () => void;
  onToggleFlowMode?: () => void;
  onAttachRealm?: () => void;
  onScanCwd?: () => void;
  onOpenComposer?: () => void;
}

interface Command {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

export function CommandPalette({
  onClose, sessions, onSelectSession, onNewSession, onToggleContext, onToggleSessions, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onAttachRealm, onScanCwd, onOpenComposer,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = useMemo(() => [
    { id: "new", label: "New Session", category: "Session", shortcut: "⌘N", action: () => { onNewSession(); onClose(); } },
    { id: "ctx", label: "Toggle Context Panel", category: "View", shortcut: "⌘E", action: () => { onToggleContext(); onClose(); } },
    { id: "sidebar", label: "Toggle Session List", category: "View", shortcut: "⌘B", action: () => { onToggleSessions(); onClose(); } },
    { id: "settings", label: "Settings", category: "App", shortcut: "⌘,", action: () => { onOpenSettings(); onClose(); } },
    { id: "workspace", label: "Projects", category: "App", action: () => { onOpenWorkspace(); onClose(); } },
    ...(onOpenCostDashboard ? [{ id: "cost-dashboard", label: "Cost Dashboard", category: "App", shortcut: "⌘⇧D", action: () => { onOpenCostDashboard(); onClose(); } }] : []),
    ...(onToggleFlowMode ? [{ id: "flow-mode", label: "Toggle Flow Mode", category: "View", shortcut: "⌘⇧F", action: () => { onToggleFlowMode(); onClose(); } }] : []),
    ...(onAttachRealm ? [{ id: "attach-realm", label: "Add Project...", category: "Projects", action: () => { onAttachRealm(); onClose(); } }] : []),
    ...(onScanCwd ? [{ id: "scan-cwd", label: "Scan Current Directory", category: "Projects", action: () => { onScanCwd(); onClose(); } }] : []),
    ...(onOpenComposer ? [{ id: "composer", label: "Prompt Composer", category: "Tools", shortcut: "⌘J", action: () => { onOpenComposer(); onClose(); } }] : []),
    ...sessions.map((s, i) => ({
      id: `session-${s.id}`,
      label: s.label,
      category: s.detected_agent?.name || "Session",
      shortcut: i < 9 ? `⌘${i + 1}` : undefined,
      action: () => { onSelectSession(s.id); onClose(); },
    })),
  ], [sessions, onNewSession, onClose, onToggleContext, onToggleSessions, onSelectSession, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onAttachRealm, onScanCwd, onOpenComposer]);

  const filtered = useMemo(() => query
    ? commands.filter((c) => c.label.toLowerCase().includes(query.toLowerCase()) || c.category.toLowerCase().includes(query.toLowerCase()))
    : commands,
  [query, commands]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSelectedIndex(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter" && filtered[selectedIndex]) { filtered[selectedIndex].action(); return; }
  };

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Type a command or session name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette-results">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${i === selectedIndex ? "command-palette-item-selected" : ""}`}
              onClick={cmd.action}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="command-palette-label">{cmd.label}</span>
              <span className="command-palette-category">{cmd.category}</span>
              {cmd.shortcut && <span className="command-palette-shortcut">{cmd.shortcut}</span>}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="command-palette-empty">No results for "{query}"</div>
          )}
        </div>
      </div>
    </div>
  );
}
