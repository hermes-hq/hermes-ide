import type { ReactNode } from "react";
import { Menu, type MenuTriggerProps } from "./ui/Menu";

export interface PermissionModeInfo {
  id: string;
  label: string;
  description: string;
  /** Visual cue: "danger" gets the red treatment for `bypassPermissions`. */
  tone?: "default" | "danger";
}

/** Claude's published `--permission-mode` values, in escalating-autonomy order. */
export const CLAUDE_PERMISSION_MODES: PermissionModeInfo[] = [
  {
    id: "default",
    label: "Default",
    description: "Asks before edits and risky tools",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only — propose a plan, no execution",
  },
  {
    id: "acceptEdits",
    label: "Accept Edits",
    description: "Auto-approves file edits",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Auto-approves everything (use carefully)",
    tone: "danger",
  },
];

interface PermissionPickerProps {
  current: string | null;
  onSelect: (modeId: string) => void;
  /** The composer's permission chip; it opens the menu. */
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
}

/**
 * Permission-mode menu behind the composer's permission chip: the kit Menu
 * (↑ ↓ Home End, type-ahead, Enter, Esc). Bypass is drawn as a destructive
 * item; the current mode carries the check.
 */
export function PermissionPicker({ current, onSelect, renderTrigger }: PermissionPickerProps) {
  return (
    <Menu
      label="Select permission mode"
      className="permission-picker"
      renderTrigger={renderTrigger}
      footer={<>Applies now; on your next message Claude restarts with the new <kbd>--permission-mode</kbd></>}
      entries={CLAUDE_PERMISSION_MODES.map((opt) => ({
        id: `mode-${opt.id}`,
        label: opt.label,
        detail: opt.description,
        danger: opt.tone === "danger",
        checked: current === opt.id || (current == null && opt.id === "default"),
        onSelect: () => onSelect(opt.id),
      }))}
    />
  );
}
