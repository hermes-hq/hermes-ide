import "../styles/components/CommandPalette.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { SessionData } from "../state/SessionContext";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { fmt } from "../utils/platform";

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
  pluginCommands?: { command: string; title: string; category?: string; pluginId: string; pluginName: string }[];
  pluginsWithSettings?: { pluginId: string; pluginName: string }[];
  onPluginCommand?: (commandId: string) => void;
  onCheckPluginUpdates?: () => void;
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
  onClose, sessions, onSelectSession, onNewSession, onToggleContext, onToggleSessions, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onAttachProject, onScanCwd, onOpenComposer, onOpenShortcuts, onToggleGit, onToggleSearch, pluginCommands, pluginsWithSettings, onPluginCommand, onCheckPluginUpdates,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onContextMenu: textContextMenu } = useTextContextMenu();

  const commands: Command[] = useMemo(() => [
    { id: "new", label: "New Session", category: "Session", shortcut: fmt("{mod}N"), action: () => { onNewSession(); onClose(); } },
    { id: "ctx", label: "Toggle Context Panel", category: "View", shortcut: fmt("{mod}E"), action: () => { onToggleContext(); onClose(); } },
    { id: "sidebar", label: "Toggle Sidebar", category: "View", shortcut: fmt("{mod}B"), action: () => { onToggleSessions(); onClose(); } },
    { id: "settings", label: "Settings", category: "App", shortcut: fmt("{mod},"), action: () => { onOpenSettings(); onClose(); } },
    { id: "settings-general", label: "Settings / General", category: "Settings", hidden: true, action: () => { onOpenSettings("general"); onClose(); } },
    { id: "settings-appearance", label: "Settings / Appearance", category: "Settings", hidden: true, action: () => { onOpenSettings("appearance"); onClose(); } },
    { id: "settings-theme", label: "Settings / Theme", category: "Settings", hidden: true, action: () => { onOpenSettings("appearance"); onClose(); } },
    { id: "settings-autonomous", label: "Settings / Autonomous", category: "Settings", hidden: true, action: () => { onOpenSettings("autonomous"); onClose(); } },
    { id: "settings-git", label: "Settings / Git", category: "Settings", hidden: true, action: () => { onOpenSettings("git"); onClose(); } },
    { id: "settings-privacy", label: "Settings / Privacy", category: "Settings", hidden: true, action: () => { onOpenSettings("privacy"); onClose(); } },
        { id: "settings-shortcuts", label: "Settings / Shortcuts", category: "Settings", hidden: true, action: () => { onOpenSettings("shortcuts"); onClose(); } },
    { id: "settings-plugins", label: "Settings / Plugins", category: "Settings", hidden: true, action: () => { onOpenSettings("plugins"); onClose(); } },
    ...(pluginsWithSettings ?? []).map(p => ({
      id: `settings-plugin-${p.pluginId}`,
      label: `Settings / ${p.pluginName}`,
      category: "Plugin Settings",
      hidden: true,
      action: () => { onOpenSettings("plugins"); onClose(); },
    })),
    { id: "workspace", label: "Folders", category: "App", action: () => { onOpenWorkspace(); onClose(); } },
    ...(onOpenCostDashboard ? [{ id: "cost-dashboard", label: "Cost Dashboard", category: "App", shortcut: fmt("{mod}$"), action: () => { onOpenCostDashboard(); onClose(); } }] : []),
    ...(onToggleFlowMode ? [{ id: "flow-mode", label: "Toggle Flow Mode", category: "View", shortcut: fmt("{mod}{shift}Z"), action: () => { onToggleFlowMode(); onClose(); } }] : []),
    ...(onAttachProject ? [{ id: "attach-project", label: "Add Folder...", category: "Folders", action: () => { onAttachProject(); onClose(); } }] : []),
    ...(onScanCwd ? [{ id: "scan-cwd", label: "Scan Current Directory", category: "Folders", action: () => { onScanCwd(); onClose(); } }] : []),
    ...(onOpenComposer ? [{ id: "composer", label: "Prompt Composer", category: "Tools", shortcut: fmt("{mod}J"), action: () => { onOpenComposer(); onClose(); } }] : []),
    ...(onOpenShortcuts ? [{ id: "shortcuts", label: "Keyboard Shortcuts", category: "Help", shortcut: fmt("{mod}/"), action: () => { onOpenShortcuts(); onClose(); } }] : []),
    ...(onToggleGit ? [{ id: "git", label: "Toggle Git Panel", category: "View", shortcut: fmt("{mod}G"), action: () => { onToggleGit(); onClose(); } }] : []),
    ...(onToggleSearch ? [{ id: "search", label: "Search in Folder", category: "View", shortcut: fmt("{mod}{shift}F"), action: () => { onToggleSearch(); onClose(); } }] : []),
    ...sessions.map((s, i) => ({
      id: `session-${s.id}`,
      label: s.label,
      category: s.detected_agent?.name || "Session",
      shortcut: i < 9 ? fmt(`{mod}${i + 1}`) : undefined,
      action: () => { onSelectSession(s.id); onClose(); },
    })),
    ...(onCheckPluginUpdates ? [{ id: "check-plugin-updates", label: "Check for Plugin Updates", category: "Plugins", action: () => { onCheckPluginUpdates(); onClose(); } }] : []),
    ...(pluginCommands ?? []).map(pc => ({
      id: `plugin-${pc.command}`,
      label: pc.title,
      category: pc.category || pc.pluginName || "Plugin",
      action: () => { onPluginCommand?.(pc.command); onClose(); },
    })),
  ], [sessions, onNewSession, onClose, onToggleContext, onToggleSessions, onSelectSession, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onAttachProject, onScanCwd, onOpenComposer, onOpenShortcuts, onToggleGit, onToggleSearch, pluginCommands, pluginsWithSettings, onPluginCommand, onCheckPluginUpdates]);

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
    <div className="command-palette-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="Type a command or session name..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onContextMenu={textContextMenu}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="command-palette-results" role="listbox">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`command-palette-item ${i === selectedIndex ? "command-palette-item-selected" : ""}`}
              role="option"
              aria-selected={i === selectedIndex}
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
