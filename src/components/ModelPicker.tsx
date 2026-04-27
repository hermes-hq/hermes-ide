import "../styles/components/ModelPicker.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelInfo } from "../api/sessions";
import { isCurrentModel } from "../utils/modelPicker";

interface ModelPickerProps {
  anchorEl: HTMLElement | null;
  /** Models discovered from the local Claude CLI; empty when discovery failed. */
  options: ModelInfo[];
  currentModel: string | null;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

/** Sentinel id passed to onSelect for the "Open Claude's picker…" escape hatch. */
const OPEN_PICKER_ID = "";

export function ModelPicker({ anchorEl, options, currentModel, onSelect, onClose }: ModelPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>({
    top: 0, left: 0, width: 240,
  });

  // Position the picker just above the chip in viewport coordinates.
  useLayoutEffect(() => {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    setPos({
      top: r.top - 8,            // 8px above the chip
      left: r.left,
      width: Math.max(240, r.width),
    });
  }, [anchorEl]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (anchorEl && anchorEl.contains(e.target as Node)) return; // click on chip toggles, handled there
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

  const hasOptions = options.length > 0;

  return createPortal(
    <div
      className="model-picker"
      ref={ref}
      role="menu"
      aria-label="Select model"
      style={{
        top: pos.top,
        left: pos.left,
        minWidth: pos.width,
        transform: "translateY(-100%)",
      }}
    >
      <div className="model-picker-header">Switch model</div>
      {!hasOptions && (
        <div className="model-picker-note">
          Discovery unavailable on this Claude version.
        </div>
      )}
      {hasOptions && options.map((opt) => {
        const isCurrent = isCurrentModel(opt, currentModel);
        return (
          <button
            key={opt.id}
            type="button"
            role="menuitem"
            className={`model-picker-item ${isCurrent ? "model-picker-item-current" : ""}`}
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
      <button
        key="__open-claude-picker__"
        type="button"
        role="menuitem"
        className="model-picker-item"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onSelect(OPEN_PICKER_ID);
        }}
      >
        <div className="model-picker-row">
          <span className="model-picker-label">Open Claude's picker…</span>
        </div>
        <div className="model-picker-desc">
          Show Claude's full model menu in the terminal
        </div>
      </button>
      <div className="model-picker-footer">
        Switching sends <kbd>/model &lt;name&gt;</kbd> to Claude
      </div>
    </div>,
    document.body,
  );
}
