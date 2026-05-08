import "../styles/components/ModelPicker.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  anchorEl: HTMLElement | null;
  current: string | null;
  onSelect: (modeId: string) => void;
  onClose: () => void;
}

/**
 * Permission-mode picker.  Mirrors `ModelPicker`'s anchored-portal pattern
 * (see `src/components/ModelPicker.tsx`) so both chips have the same
 * positioning + dismiss-on-outside-click behavior.  Reuses ModelPicker's CSS
 * file for the panel chrome — keeps the visual language consistent without
 * duplicating styles.
 */
export function PermissionPicker({ anchorEl, current, onSelect, onClose }: PermissionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: 0, left: 0, width: 260,
  });

  useLayoutEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    setPos({
      top: r.top - 8,
      left: r.left,
      width: Math.max(260, r.width),
    });
  }, [anchorEl]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (anchorEl && anchorEl.contains(e.target as Node)) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onDocClick);
    }, 0);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchorEl]);

  return createPortal(
    <div
      className="model-picker"
      ref={ref}
      role="menu"
      aria-label="Select permission mode"
      style={{
        top: pos.top,
        left: pos.left,
        minWidth: pos.width,
        transform: "translateY(-100%)",
      }}
    >
      <div className="model-picker-header">Permission mode</div>
      {CLAUDE_PERMISSION_MODES.map((opt) => {
        const isCurrent = current === opt.id || (current == null && opt.id === "default");
        return (
          <button
            key={opt.id}
            type="button"
            role="menuitem"
            className={`model-picker-item ${isCurrent ? "model-picker-item-current" : ""} ${opt.tone === "danger" ? "model-picker-item-danger" : ""}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(opt.id);
            }}
          >
            <div className="model-picker-row">
              <span className="model-picker-label">{opt.label}</span>
              {isCurrent && <span className="model-picker-dot" aria-label="Current">●</span>}
            </div>
            <div className="model-picker-desc">{opt.description}</div>
          </button>
        );
      })}
      <div className="model-picker-footer">
        Respawns Claude with the new <kbd>--permission-mode</kbd>
      </div>
    </div>,
    document.body,
  );
}
