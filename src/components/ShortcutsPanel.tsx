import "../styles/components/ShortcutsPanel.css";
import { useEffect } from "react";
import { fmt } from "../utils/platform";

export interface Shortcut {
  keys: string;
  action: string;
}

export interface ShortcutGroup {
  label: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    label: "General",
    shortcuts: [
      { keys: "{mod}N", action: "New Session" },
      { keys: "{mod}W", action: "Close Pane / Session" },
      { keys: "{mod}K / {mod}{shift}P", action: "Command Palette" },
      { keys: "{mod},", action: "Settings" },
      { keys: "{mod}/", action: "Keyboard Shortcuts" },
      { keys: "{mod}J", action: "Prompt Composer" },
      { keys: "{mod}{shift}C", action: "Copy Context" },
      { keys: "{mod}{shift}F", action: "Search in Folder" },
      { keys: "{mod}{shift}Z", action: "Toggle Flow Mode" },
    ],
  },
  {
    label: "Panels",
    shortcuts: [
      { keys: "{mod}B", action: "Toggle Sidebar" },
      { keys: "{mod}E", action: "Toggle Context Panel" },
      { keys: "{mod}P", action: "Processes" },
      { keys: "{mod}G", action: "Git" },
      { keys: "{mod}F", action: "Files" },
      { keys: "{mod}T", action: "Toggle Timeline" },
      { keys: "{mod}$", action: "Cost Dashboard" },
    ],
  },
  {
    label: "Panes & Sessions",
    shortcuts: [
      { keys: "{mod}D", action: "Split Horizontal" },
      { keys: "{mod}{shift}D", action: "Split Vertical" },
      { keys: "{mod}{alt}→", action: "Focus Next Pane" },
      { keys: "{mod}{alt}←", action: "Focus Previous Pane" },
      { keys: "{mod}1-9", action: "Switch to Session" },
    ],
  },
];

interface ShortcutsPanelProps {
  onClose: () => void;
}

export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
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
          <span className="shortcuts-title">Keyboard Shortcuts</span>
          <button className="close-btn shortcuts-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map((group) => (
            <div key={group.label} className="shortcuts-group">
              <div className="shortcuts-group-label">{group.label}</div>
              <div className="shortcuts-table">
                {group.shortcuts.map((s) => (
                  <div key={s.keys} className="shortcuts-row">
                    <span className="shortcuts-action">{s.action}</span>
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
