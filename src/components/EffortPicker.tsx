import type { ReactNode } from "react";
import { Menu, type MenuEntry, type MenuTriggerProps } from "./ui/Menu";

interface EffortPickerProps {
  /** All effort levels discovered from `claude --help`. Empty when undiscoverable. */
  levels: string[];
  /** The level last chosen. */
  current: string | null;
  /** Pending level set optimistically while Claude restarts with it. */
  pending: string | null;
  onSelect: (level: string) => void;
  /** The composer's effort chip; it opens the menu. */
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
}

/**
 * Effort levels are exposed as flat strings by Claude (low / medium / high /
 * xhigh / max), without descriptions, so the rows are the levels alone. The
 * kit Menu: ↑ ↓ Home End and type-ahead move, Enter picks, Esc closes.
 */
export function EffortPicker({ levels, current, pending, onSelect, renderTrigger }: EffortPickerProps) {
  const activeKey = (pending ?? current ?? "").toLowerCase();
  const entries: MenuEntry[] =
    levels.length === 0
      ? [{ id: "none", label: "Discovery unavailable on this Claude version.", disabled: true, onSelect: () => {} }]
      : levels.map((level) => ({
          id: `effort-${level}`,
          label: level,
          checked: level.toLowerCase() === activeKey,
          onSelect: () => onSelect(level),
        }));
  return (
    <Menu
      label="Select thinking effort"
      entries={entries}
      renderTrigger={renderTrigger}
      className="effort-picker"
      footer={<>From your next message: Claude restarts with the new <kbd>--effort</kbd>, same conversation</>}
    />
  );
}
