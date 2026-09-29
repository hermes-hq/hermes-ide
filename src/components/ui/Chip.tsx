import type { ReactNode } from "react";
import "../../styles/ui/chip.css";
import { cx } from "./Button";
import { CloseGlyph } from "./icons";

interface ChipBase {
  children: ReactNode;
  /** md (28 px) by default, sm (24). */
  size?: "sm" | "md";
  className?: string;
}

interface StaticChip extends ChipBase {
  selected?: undefined;
  onToggle?: undefined;
}

interface ToggleChip extends ChipBase {
  /** A chip that can be switched on and off (aria-pressed). */
  selected: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}

type Removable =
  | { onRemove?: undefined; removeLabel?: undefined }
  /** A trailing × removes the chip; its accessible name is required. */
  | { onRemove: () => void; removeLabel: string };

export type ChipProps = (StaticChip | ToggleChip) & Removable;

/**
 * A compact value: a model, a filter, a scope. Neutral by default; a
 * selectable chip turns brass when on; a removable chip ends with a small ×.
 */
export function Chip(props: ChipProps) {
  const { children, size = "md", className } = props;
  const toggle = props.onToggle !== undefined;
  const classes = cx("h-chip", `h-chip--${size}`, toggle && props.selected && "h-chip--selected", className);
  const remove =
    props.onRemove !== undefined ? (
      <button
        type="button"
        className="h-chip-remove"
        aria-label={props.removeLabel}
        title={props.removeLabel}
        onClick={(e) => {
          e.stopPropagation();
          props.onRemove?.();
        }}
      >
        <CloseGlyph />
      </button>
    ) : null;

  if (toggle) {
    const p = props as ToggleChip & Removable;
    return (
      <span className={cx(classes, "h-chip--interactive")}>
        <button
          type="button"
          className="h-chip-button"
          aria-pressed={p.selected}
          disabled={p.disabled}
          onClick={() => p.onToggle(!p.selected)}
        >
          {children}
        </button>
        {remove}
      </span>
    );
  }
  return (
    <span className={classes}>
      <span className="h-chip-label">{children}</span>
      {remove}
    </span>
  );
}
