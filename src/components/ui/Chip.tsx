import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import "../../styles/ui/chip.css";
import { cx } from "./Button";
import { CloseGlyph } from "./icons";

interface ChipBase extends Omit<HTMLAttributes<HTMLElement>, "children" | "onClick" | "onToggle"> {
  children: ReactNode;
  /** md (28 px) by default, sm (24). */
  size?: "sm" | "md";
}

interface StaticChip extends ChipBase {
  selected?: undefined;
  onToggle?: undefined;
  onClick?: undefined;
}

interface ToggleChip extends ChipBase {
  /** A chip that can be switched on and off (aria-pressed). */
  selected: boolean;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
  onClick?: undefined;
}

interface ActionChip extends ChipBase {
  /**
   * A chip that does something when pressed, such as opening the detail
   * behind it. The whole pill is one button.
   */
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  /** For a chip that opens a popover: whether it is open (aria-expanded). */
  expanded?: boolean;
  /** What it opens (aria-haspopup). */
  haspopup?: "dialog" | "menu" | "listbox";
  disabled?: boolean;
  selected?: undefined;
  onToggle?: undefined;
}

type Removable =
  | { onRemove?: undefined; removeLabel?: undefined }
  /** A trailing × removes the chip; its accessible name is required. */
  | { onRemove: () => void; removeLabel: string };

export type ChipProps = ((StaticChip | ToggleChip) & Removable) | (ActionChip & { onRemove?: undefined; removeLabel?: undefined });

/**
 * A compact value: a model, a filter, a scope. Neutral by default; a
 * selectable chip turns brass when on; a removable chip ends with a small ×;
 * an action chip is one button (a header chip that opens its detail).
 * Other attributes (title, data-*, aria-*) go on the chip's outer element.
 */
export function Chip(props: ChipProps) {
  const { children, size = "md", className, selected, onToggle, onRemove, removeLabel, onClick, ...rest } = props;
  const classes = cx("h-chip", `h-chip--${size}`, onToggle !== undefined && selected && "h-chip--selected", className);

  if (onClick !== undefined) {
    const { expanded, haspopup, disabled, ...attrs } = rest as Omit<ActionChip, "children" | "size" | "className" | "onClick">;
    return (
      <button
        {...attrs}
        type="button"
        className={cx(classes, "h-chip--action")}
        aria-expanded={expanded}
        aria-haspopup={haspopup}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    );
  }

  const remove =
    onRemove !== undefined ? (
      <button
        type="button"
        className="h-chip-remove"
        aria-label={removeLabel}
        title={removeLabel}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <CloseGlyph />
      </button>
    ) : null;

  if (onToggle !== undefined) {
    const { disabled, ...attrs } = rest as Omit<ToggleChip, "children" | "size" | "className" | "selected" | "onToggle">;
    return (
      <span {...attrs} className={cx(classes, "h-chip--interactive")}>
        <button type="button" className="h-chip-button" aria-pressed={selected} disabled={disabled} onClick={() => onToggle(!selected)}>
          {children}
        </button>
        {remove}
      </span>
    );
  }
  return (
    <span {...rest} className={classes}>
      <span className="h-chip-label">{children}</span>
      {remove}
    </span>
  );
}
