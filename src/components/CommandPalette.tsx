import "../styles/components/CommandPalette.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { SessionData } from "../state/SessionContext";
import { useTextContextMenu } from "../hooks/useTextContextMenu";

interface CommandPaletteProps {
  onClose: () => void;
  sessions: SessionData[];
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onToggleContext: () => void;
  onToggleSessions: () => void;
  onOpenSettings: (tab?: string) => void;
  onOpenWorkspace: () => void;
  onOpenCostDashboard?: () => void;
  onToggleFlowMode?: () => void;
  onAttachProject?: () => void;
  onScanCwd?: () => void;
  onOpenComposer?: () => void;
  onOpenShortcuts?: () => void;
  onToggleGit?: () => void;
  onToggleSearch?: () => void;
}

interface Command {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  hidden?: boolean;
  action: () => void;
}

export function CommandPalette({
  onClose, sessions, onSelectSession, onNewSession, onToggleContext, onToggleSessions, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onAttachProject, onScanCwd, onOpenComposer, onOpenShortcuts, onToggleGit, onToggleSearch,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onContextMenu: textContextMenu } = useTextContextMenu();

  const commands: Command[] = useMemo(() => [
    { id: "new", label: "New Session", category: "Session", shortcut: "⌘N", action: () => { onNewSession(); onClose(); } },
    { id: "ctx", label: "Toggle Context Panel", category: "View", shortcut: "⌘E", action: () => { onToggleContext(); onClose(); } },
    { id: "sidebar", label: "Toggle Session List", category: "View", shortcut: "⌘B", action: () => { onToggleSessions(); onClose(); } },
    { id: "settings", label: "Settings", category: "App", shortcut: "⌘,", action: () => { onOpenSettings(); onClose(); } },
    { id: "settings-general", label: "Settings / General", category: "Settings", hidden: true, action: () => { onOpenSettings("general"); onClose(); } },
    { id: "settings-appearance", label: "Settings / Appearance", category: "Settings", hidden: true, action: () => { onOpenSettings("appearance"); onClose(); } },
    { id: "settings-theme", label: "Settings / Theme", category: "Settings", hidden: true, action: () => { onOpenSettings("appearance"); onClose(); } },
    { id: "settings-autonomous", label: "Settings / Autonomous", category: "Settings", hidden: true, action: () => { onOpenSettings("autonomous"); onClose(); } },
    { id: "settings-shortcuts", label: "Settings / Shortcuts", category: "Settings", hidden: true, action: () => { onOpenSettings("shortcuts"); onClose(); } },
    { id: "workspace", label: "Projects", category: "App", action: () => { onOpenWorkspace(); onClose(); } },
    ...(onOpenCostDashboard ? [{ id: "cost-dashboard", label: "Cost Dashboard", category: "App", shortcut: "⌘$", action: () => { onOpenCostDashboard(); onClose(); } }] : []),
    ...(onToggleFlowMode ? [{ id: "flow-mode", label: "Toggle Flow Mode", category: "View", shortcut: "⌘⇧Z", action: () => { onToggleFlowMode(); onClose(); } }] : []),
    ...(onAttachProject ? [{ id: "attach-project", label: "Add Project...", category: "Projects", action: () => { onAttachProject(); onClose(); } }] : []),
    ...(onScanCwd ? [{ id: "scan-cwd", label: "Scan Current Directory", category: "Projects", action: () => { onScanCwd(); onClose(); } }] : []),
    ...(onOpenComposer ? [{ id: "composer", label: "Prompt Composer", category: "Tools", shortcut: "⌘J", action: () => { onOpenComposer(); onClose(); } }] : []),
    ...(onOpenShortcuts ? [{ id: "shortcuts", label: "Keyboard Shortcuts", category: "Help", shortcut: "⌘/", action: () => { onOpenShortcuts(); onClose(); } }] : []),
    ...(onToggleGit ? [{ id: "git", label: "Toggle Git Panel", category: "View", shortcut: "⌘G", action: () => { onToggleGit(); onClose(); } }] : []),
    ...(onToggleSearch ? [{ id: "search", label: "Search Project", category: "View", shortcut: "⌘⇧F", action: () => { onToggleSearch(); onClose(); } }] : []),
    ...sessions.map((s, i) => ({
      id: `session-${s.id}`,
      label: s.label,
      category: s.detected_agent?.name || "Session",
      shortcut: i < 9 ? `⌘${i + 1}` : undefined,
      action: () => { onSelectSession(s.id); onClose(); },
    })),
  ], [sessions, onNewSession, onClose, onToggleContext, onToggleSessions, onSelectSession, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onAttachProject, onScanCwd, onOpenComposer, onOpenShortcuts, onToggleGit, onToggleSearch]);

  const filtered = useMemo(() => {
    if (!query) return commands.filter((c) => !c.hidden);
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSelectedIndex(0); }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((i) => filtered.length === 0 ? 0 : Math.min(i + 1, filtered.length - 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); return; }
    if (e.key === "Enter") {
      const safeIdx = Math.min(selectedIndex, filtered.length - 1);
      if (safeIdx >= 0 && filtered[safeIdx]) { filtered[safeIdx].action(); }
      return;
    }
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
          onContextMenu={textContextMenu}
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
