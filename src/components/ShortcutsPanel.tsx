import "../styles/components/ShortcutsPanel.css";
import { useEffect } from "react";
import { PLATFORM, formatChord, type Platform } from "../utils/platform";
import { shortcutLabel } from "../utils/keymap";
import { useI18n } from "../i18n/I18nProvider";

export interface Shortcut {
  /** Menu action whose platform chord is shown (see utils/keymap.ts). */
  action?: string;
  /** Canonical chord, for shortcuts that are not menu actions. */
  keys?: string;
  actionKey: string;
}

export interface ShortcutGroup {
  labelKey: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    labelKey: "shortcuts.general",
    shortcuts: [
      { action: "file.new-session", actionKey: "session.new" },
      { action: "file.close-pane", actionKey: "shortcuts.closePaneSession" },
      { action: "view.command-palette", keys: "{mod}{shift}P", actionKey: "shortcuts.commandPalette" },
      { action: "hermes.settings", actionKey: "settings.title" },
      { action: "view.shortcuts", actionKey: "shortcuts.title" },
      { action: "view.prompt-composer", actionKey: "shortcuts.promptComposer" },
      { action: "session.copy-context", actionKey: "shortcuts.copyContext" },
      { action: "view.search-panel", actionKey: "shortcuts.searchInFolder" },
      { action: "view.flow-mode", actionKey: "shortcuts.toggleFlowMode" },
    ],
  },
  {
    labelKey: "shortcuts.panels",
    shortcuts: [
      { action: "view.toggle-sidebar", actionKey: "palette.toggleSidebar" },
      { action: "view.context-panel", actionKey: "palette.toggleContext" },
      { action: "view.process-panel", actionKey: "shortcuts.processes" },
      { action: "view.git-panel", actionKey: "shortcuts.git" },
      { action: "file.file-explorer", actionKey: "shortcuts.files" },
      { action: "file.new-session-tab", actionKey: "shortcuts.toggleTimeline" },
      { action: "view.cost-dashboard", actionKey: "palette.costDashboard" },
    ],
  },
  {
    labelKey: "shortcuts.panesSessions",
    shortcuts: [
      { action: "view.split-horizontal", actionKey: "shortcuts.splitHorizontal" },
      { action: "view.split-vertical", actionKey: "shortcuts.splitVertical" },
      { keys: "{mod}{alt}→", actionKey: "shortcuts.focusNextPane" },
      { keys: "{mod}{alt}←", actionKey: "shortcuts.focusPreviousPane" },
      { keys: "{mod}1-9", actionKey: "shortcuts.switchToSession" },
    ],
  },
];

/** The chord text shown for a shortcut on a platform, e.g. "Ctrl+Shift+D". */
export function shortcutText(s: Shortcut, platform: Platform = PLATFORM): string {
  const parts: string[] = [];
  if (s.action) parts.push(shortcutLabel(s.action, platform));
  if (s.keys) parts.push(formatChord(s.keys, platform));
  return parts.filter(Boolean).join(" / ");
}

interface ShortcutsPanelProps {
  onClose: () => void;
}

export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
  const { t } = useI18n();
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="shortcuts-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="shortcuts-panel" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-header">
          <span className="shortcuts-title">{t("shortcuts.title")}</span>
          <button className="close-btn shortcuts-close" onClick={onClose} aria-label={t("common.close")}>&times;</button>
        </div>
        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.labelKey} className="shortcuts-group">
              <div className="shortcuts-group-label">{t(group.labelKey)}</div>
              <div className="shortcuts-table">
                {group.shortcuts.map((s) => (
                  <div key={s.actionKey} className="shortcuts-row">
                    <span className="shortcuts-action">{t(s.actionKey)}</span>
                    <kbd className="shortcuts-kbd">{shortcutText(s)}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
