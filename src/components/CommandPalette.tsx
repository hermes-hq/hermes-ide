import "../styles/components/CommandPalette.css";
import { useState, useEffect, useRef, useMemo } from "react";
import { SessionData } from "../state/SessionContext";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { fmt } from "../utils/platform";
import { shortcutLabel } from "../utils/keymap";
import { useI18n } from "../i18n/I18nProvider";
import { ListRow } from "./ui/ListRow";

interface CommandPaletteProps {
  onClose: () => void;
  sessions: SessionData[];
  /** The session in view: its row is marked as the current one. */
  activeSessionId?: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onToggleContext: () => void;
  onToggleSessions: () => void;
  onOpenSettings: (tab?: string) => void;
  onOpenWorkspace: () => void;
  onOpenCostDashboard?: () => void;
  onToggleFlowMode?: () => void;
  /** F24: tile the sessions whose agent is working (fleetPerf flag). */
  onTileWorkingAgents?: () => void;
  onAttachProject?: () => void;
  onScanCwd?: () => void;
  onOpenComposer?: () => void;
  onOpenShortcuts?: () => void;
  onToggleGit?: () => void;
  /** F21: label the git entry "Review Desk" when the flag routes ⌘G there. */
  reviewDesk?: boolean;
  onToggleSearch?: () => void;
  /** Feature Tracks (F28), only while the flag is on. */
  onToggleTrack?: () => void;
  onApproveGate?: () => void;
  onMakeFeature?: () => void;
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
  onClose, sessions, activeSessionId, onSelectSession, onNewSession, onToggleContext, onToggleSessions, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onTileWorkingAgents, onAttachProject, onScanCwd, onOpenComposer, onOpenShortcuts, onToggleGit, reviewDesk, onToggleSearch, onToggleTrack, onApproveGate, onMakeFeature, pluginCommands, pluginsWithSettings, onPluginCommand, onCheckPluginUpdates,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { onContextMenu: textContextMenu } = useTextContextMenu();
  const { t, currentLanguage } = useI18n();

  const commands: Command[] = useMemo(() => [
    { id: "new", label: t("palette.newSession"), category: t("app.session"), shortcut: shortcutLabel("file.new-session"), action: () => { onNewSession(); onClose(); } },
    { id: "ctx", label: t("palette.toggleContext"), category: t("app.view"), shortcut: shortcutLabel("view.context-panel"), action: () => { onToggleContext(); onClose(); } },
    { id: "sidebar", label: t("palette.toggleSidebar"), category: t("app.view"), shortcut: shortcutLabel("view.toggle-sidebar"), action: () => { onToggleSessions(); onClose(); } },
    { id: "settings", label: t("app.settings"), category: t("app.app"), shortcut: fmt("{mod},"), action: () => { onOpenSettings(); onClose(); } },
    { id: "settings-general", label: t("palette.settingsGeneral"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("general"); onClose(); } },
    { id: "settings-appearance", label: t("palette.settingsAppearance"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("appearance"); onClose(); } },
    { id: "settings-theme", label: t("palette.settingsTheme"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("appearance"); onClose(); } },
    { id: "settings-git", label: t("palette.settingsGit"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("git"); onClose(); } },
    { id: "settings-privacy", label: t("palette.settingsPrivacy"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("privacy"); onClose(); } },
    { id: "settings-shortcuts", label: t("palette.settingsShortcuts"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("shortcuts"); onClose(); } },
    { id: "settings-plugins", label: t("palette.settingsPlugins"), category: t("app.settings"), hidden: true, action: () => { onOpenSettings("plugins"); onClose(); } },
    ...(pluginsWithSettings ?? []).map(p => ({
      id: `settings-plugin-${p.pluginId}`,
      label: t("palette.pluginSettings", { name: p.pluginName }),
      category: t("app.plugins"),
      hidden: true,
      action: () => { onOpenSettings("plugins"); onClose(); },
    })),
    { id: "workspace", label: t("app.folders"), category: t("app.app"), action: () => { onOpenWorkspace(); onClose(); } },
    ...(onOpenCostDashboard ? [{ id: "cost-dashboard", label: t("palette.costDashboard"), category: t("app.app"), shortcut: fmt("{mod}$"), action: () => { onOpenCostDashboard(); onClose(); } }] : []),
    ...(onToggleFlowMode ? [{ id: "flow-mode", label: t("palette.toggleFlowMode"), category: t("app.view"), shortcut: fmt("{mod}{shift}Z"), action: () => { onToggleFlowMode(); onClose(); } }] : []),
    ...(onTileWorkingAgents ? [{ id: "tile-working-agents", label: t("fleet.tileWorkingAgents"), category: t("app.view"), action: () => { onTileWorkingAgents(); onClose(); } }] : []),
    ...(onAttachProject ? [{ id: "attach-project", label: t("palette.addFolder"), category: t("app.folders"), action: () => { onAttachProject(); onClose(); } }] : []),
    ...(onScanCwd ? [{ id: "scan-cwd", label: t("palette.scanCurrentDirectory"), category: t("app.folders"), action: () => { onScanCwd(); onClose(); } }] : []),
    ...(onOpenComposer ? [{ id: "composer", label: t("palette.promptComposer"), category: t("app.tools"), shortcut: shortcutLabel("view.prompt-composer"), action: () => { onOpenComposer(); onClose(); } }] : []),
    ...(onOpenShortcuts ? [{ id: "shortcuts", label: t("palette.keyboardShortcuts"), category: t("app.help"), shortcut: fmt("{mod}/"), action: () => { onOpenShortcuts(); onClose(); } }] : []),
    ...(onToggleGit ? [{ id: "git", label: reviewDesk ? t("palette.reviewDesk") : t("palette.toggleGitPanel"), category: t("app.view"), shortcut: shortcutLabel("view.git-panel"), action: () => { onToggleGit(); onClose(); } }] : []),
    ...(onToggleSearch ? [{ id: "search", label: t("palette.searchInFolder"), category: t("app.view"), shortcut: fmt("{mod}{shift}F"), action: () => { onToggleSearch(); onClose(); } }] : []),
    ...(onToggleTrack ? [{ id: "track", label: t("palette.toggleTrackPanel"), category: t("app.view"), action: () => { onToggleTrack(); onClose(); } }] : []),
    ...(onApproveGate ? [{ id: "track-approve", label: t("palette.approveGate"), category: t("app.track"), shortcut: fmt("{mod}⏎"), action: () => { onApproveGate(); onClose(); } }] : []),
    ...(onMakeFeature ? [{ id: "track-make-feature", label: t("palette.makeFeature"), category: t("app.track"), action: () => { onMakeFeature(); onClose(); } }] : []),
    ...sessions.map((s, i) => ({
      id: `session-${s.id}`,
      label: s.label,
      category: s.detected_agent?.name || t("app.session"),
      shortcut: i < 9 ? fmt(`{mod}${i + 1}`) : undefined,
      action: () => { onSelectSession(s.id); onClose(); },
    })),
    ...(onCheckPluginUpdates ? [{ id: "check-plugin-updates", label: t("palette.checkPluginUpdates"), category: t("app.plugins"), action: () => { onCheckPluginUpdates(); onClose(); } }] : []),
    ...(pluginCommands ?? []).map(pc => ({
      id: `plugin-${pc.command}`,
      label: pc.title,
      category: pc.category || pc.pluginName || t("app.plugins"),
      action: () => { onPluginCommand?.(pc.command); onClose(); },
    })),
  // currentLanguage is intentionally in the deps: t() is referentially stable,
  // so without it the memoized labels would never update on a language switch.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [sessions, onNewSession, onClose, onToggleContext, onToggleSessions, onSelectSession, onOpenSettings, onOpenWorkspace, onOpenCostDashboard, onToggleFlowMode, onTileWorkingAgents, onAttachProject, onScanCwd, onOpenComposer, onOpenShortcuts, onToggleGit, onToggleSearch, onToggleTrack, onApproveGate, onMakeFeature, pluginCommands, pluginsWithSettings, onPluginCommand, onCheckPluginUpdates, t, currentLanguage]);

  const filtered = useMemo(() => {
    if (!query) return commands.filter((c) => !c.hidden);
    const q = query.toLowerCase();
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  }, [query, commands]);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => { setSelectedIndex(0); }, [query]);
  // Keep the highlighted row in sight while the arrows move it.
  useEffect(() => {
    document.getElementById(`command-palette-option-${selectedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

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
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-autocomplete="list"
          aria-activedescendant={filtered.length > 0 ? `command-palette-option-${Math.min(selectedIndex, filtered.length - 1)}` : undefined}
          placeholder={t("palette.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onContextMenu={textContextMenu}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
        <div className="command-palette-results" role="listbox" id="command-palette-results" aria-label={t("palette.resultsLabel")}>
          {filtered.map((cmd, i) => (
            <ListRow
              key={cmd.id}
              id={`command-palette-option-${i}`}
              size="sm"
              className="command-palette-item"
              role="option"
              aria-selected={i === selectedIndex}
              highlighted={i === selectedIndex}
              current={!!activeSessionId && cmd.id === `session-${activeSessionId}`}
              aria-current={activeSessionId && cmd.id === `session-${activeSessionId}` ? "true" : undefined}
              onClick={cmd.action}
              onMouseEnter={() => setSelectedIndex(i)}
            >
              <span className="h-row-label command-palette-label">{cmd.label}</span>
              <span className="h-row-detail command-palette-category">{cmd.category}</span>
              {cmd.shortcut && <kbd className="h-row-shortcut command-palette-shortcut">{cmd.shortcut}</kbd>}
            </ListRow>
          ))}
          {filtered.length === 0 && (
            <div className="command-palette-empty">{t("palette.noResults", { query })}</div>
          )}
        </div>
      </div>
    </div>
  );
}
