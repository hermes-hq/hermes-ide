import "../styles/components/ShortcutsPanel.css";
import { useEffect } from "react";
import { fmt } from "../utils/platform";
import { useI18n } from "../i18n/I18nProvider";

export interface Shortcut {
  keys: string;
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
      { keys: "{mod}N", actionKey: "session.new" },
      { keys: "{mod}W", actionKey: "shortcuts.closePaneSession" },
      { keys: "{mod}K / {mod}{shift}P", actionKey: "shortcuts.commandPalette" },
      { keys: "{mod},", actionKey: "settings.title" },
      { keys: "{mod}/", actionKey: "shortcuts.title" },
      { keys: "{mod}J", actionKey: "shortcuts.promptComposer" },
      { keys: "{mod}{shift}C", actionKey: "shortcuts.copyContext" },
      { keys: "{mod}{shift}F", actionKey: "shortcuts.searchInFolder" },
      { keys: "{mod}{shift}Z", actionKey: "shortcuts.toggleFlowMode" },
    ],
  },
  {
    labelKey: "shortcuts.panels",
    shortcuts: [
      { keys: "{mod}B", actionKey: "palette.toggleSidebar" },
      { keys: "{mod}E", actionKey: "palette.toggleContext" },
      { keys: "{mod}P", actionKey: "shortcuts.processes" },
      { keys: "{mod}G", actionKey: "Git" },
      { keys: "{mod}F", actionKey: "shortcuts.files" },
      { keys: "{mod}T", actionKey: "shortcuts.toggleTimeline" },
      { keys: "{mod}$", actionKey: "palette.costDashboard" },
    ],
  },
  {
    labelKey: "shortcuts.panesSessions",
    shortcuts: [
      { keys: "{mod}D", actionKey: "shortcuts.splitHorizontal" },
      { keys: "{mod}{shift}D", actionKey: "shortcuts.splitVertical" },
      { keys: "{mod}{alt}->", actionKey: "shortcuts.focusNextPane" },
      { keys: "{mod}{alt}<-", actionKey: "shortcuts.focusPreviousPane" },
      { keys: "{mod}1-9", actionKey: "shortcuts.switchToSession" },
    ],
  },
];

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
                  <div key={s.keys} className="shortcuts-row">
                    <span className="shortcuts-action">{t(s.actionKey)}</span>
                    <kbd className="shortcuts-kbd">{fmt(s.keys)}</kbd>
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
