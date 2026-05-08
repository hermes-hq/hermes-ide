import "../styles/components/EffortPicker.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface EffortPickerProps {
  anchorEl: HTMLElement | null;
  /** All effort levels discovered from `claude --help`. Empty when undiscoverable. */
  levels: string[];
  /** Active level read from `~/.claude/settings.json`. */
  current: string | null;
  /** Pending level set optimistically while Claude updates settings.json. */
  pending: string | null;
  onSelect: (level: string) => void;
  onClose: () => void;
}

/**
 * Effort levels are exposed as flat strings by Claude (low / medium / high /
 * xhigh / max), without descriptions. We render simple labels — no fixed
 * blurbs, since they would drift when Claude renames.
 */
export function EffortPicker({ anchorEl, levels, current, pending, onSelect, onClose }: EffortPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: 0, left: 0, width: 200,
  });

  useLayoutEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    setPos({
      top: r.top - 8,
      left: r.left,
      width: Math.max(200, r.width),
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

  const activeKey = (pending ?? current ?? "").toLowerCase();

  return createPortal(
    <div
      className="effort-picker"
      ref={ref}
      role="menu"
      aria-label="Select thinking effort"
      style={{
        top: pos.top,
        left: pos.left,
        minWidth: pos.width,
        transform: "translateY(-100%)",
      }}
    >
      <div className="effort-picker-header">Thinking effort</div>
      {levels.length === 0 ? (
        <div className="effort-picker-note">
          Discovery unavailable on this Claude version.
        </div>
      ) : (
        levels.map((level, idx) => {
          const isCurrent = level.toLowerCase() === activeKey;
          // Bar fill scales with the level's index so the picker mirrors the chip.
          const fill = levels.length <= 1
            ? 3
            : Math.round((idx / (levels.length - 1)) * 3);
          return (
            <button
              key={level}
              type="button"
              role="menuitem"
              className={`effort-picker-item effort-picker-fill-${fill} ${isCurrent ? "effort-picker-item-current" : ""}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSelect(level);
              }}
            >
              <span className="effort-picker-bars" aria-hidden="true">
                <span /><span /><span />
              </span>
              <span className="effort-picker-label">{level}</span>
              {isCurrent && <span className="effort-picker-dot" aria-label="Current">●</span>}
            </button>
          );
        })
      )}
      <div className="effort-picker-footer">
        Sends <kbd>/effort &lt;level&gt;</kbd> to Claude
      </div>
    </div>,
    document.body,
  );
}
