import "../styles/components/ShortcutsPanel.css";
import { useEffect } from "react";

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
      { keys: "⌘N", action: "New Session" },
      { keys: "⌘W", action: "Close Pane / Session" },
      { keys: "⌘K", action: "Command Palette" },
      { keys: "⌘,", action: "Settings" },
      { keys: "⌘/", action: "Keyboard Shortcuts" },
      { keys: "⌘J", action: "Prompt Composer" },
      { keys: "⌘⇧C", action: "Copy Context" },
      { keys: "⌘⇧F", action: "Search Project" },
      { keys: "⌘⇧Z", action: "Toggle Flow Mode" },
    ],
  },
  {
    label: "Panels",
    shortcuts: [
      { keys: "⌘B", action: "Toggle Sessions Sidebar" },
      { keys: "⌘E", action: "Toggle Context Panel" },
      { keys: "⌘P", action: "Processes" },
      { keys: "⌘G", action: "Git" },
      { keys: "⌘F", action: "Files" },
      { keys: "⌘T", action: "Toggle Timeline" },
      { keys: "⌘$", action: "Cost Dashboard" },
    ],
  },
  {
    label: "Panes & Sessions",
    shortcuts: [
      { keys: "⌘D", action: "Split Horizontal" },
      { keys: "⌘⇧D", action: "Split Vertical" },
      { keys: "⌘⌥→", action: "Focus Next Pane" },
      { keys: "⌘⌥←", action: "Focus Previous Pane" },
      { keys: "⌘1-9", action: "Switch to Session" },
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
    <div className="shortcuts-overlay" onClick={onClose}>
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
                    <kbd className="shortcuts-kbd">{s.keys}</kbd>
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
