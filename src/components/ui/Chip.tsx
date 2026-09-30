import type { HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import "../../styles/ui/chip.css";
import type { ControlAttrs } from "./attrs";
import { cx } from "./Button";
import { ChevronGlyph, CloseGlyph } from "./icons";

interface ChipBase extends Omit<HTMLAttributes<HTMLElement>, "children" | "onClick" | "onToggle"> {
  children: ReactNode;
  /** md (28 px) by default, sm (24). */
  size?: "sm" | "md";
  /** danger: the value is a risky one (e.g. an approval mode that never asks). */
  tone?: "neutral" | "danger";
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
  /**
   * The chip opens a panel of choices for its value instead of being on or
   * off: `selected` is then whether that panel is open (aria-expanded, not
   * aria-pressed) and the chip ends with a chevron.
   */
  expands?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  /** Hook class, id, tooltip and data-* attributes for the chip's button. */
  buttonAttrs?: ControlAttrs;
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
 * selectable chip turns brass when on; a chip that opens its choices shows
 * a chevron and turns brass while they are open; a removable chip ends with
 * a small ×; an action chip is one button (a header chip that opens its
 * detail). Other attributes (title, data-*, aria-*) go on the chip's outer
 * element.
 */
export function Chip(props: ChipProps) {
  const { children, size = "md", tone = "neutral", className, selected, onToggle, onRemove, removeLabel, onClick, ...rest } = props;
  const classes = cx(
    "h-chip",
    `h-chip--${size}`,
    tone === "danger" && "h-chip--danger",
    onToggle !== undefined && selected && "h-chip--selected",
    className,
  );

  if (onClick !== undefined) {
    const { expanded, haspopup, disabled, ...attrs } = rest as Omit<ActionChip, "children" | "size" | "tone" | "className" | "onClick">;
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
    const { disabled, expands, buttonRef, buttonAttrs, ...attrs } = rest as Omit<
      ToggleChip,
      "children" | "size" | "tone" | "className" | "selected" | "onToggle"
    >;
    const { className: hook, ...hookAttrs } = buttonAttrs ?? {};
    return (
      <span {...attrs} className={cx(classes, "h-chip--interactive")}>
        <button
          {...hookAttrs}
          ref={buttonRef}
          type="button"
          className={cx("h-chip-button", hook)}
          aria-pressed={expands ? undefined : selected}
          aria-expanded={expands ? selected : undefined}
          disabled={disabled}
          onClick={() => onToggle(!selected)}
        >
          <span className="h-chip-text">{children}</span>
          {expands && (
            <span className="h-chip-chevron">
              <ChevronGlyph />
            </span>
          )}
        </button>
        {remove}
      </span>
    );
  }
  return (
    <span {...rest} className={classes}>
      <span className="h-chip-label h-chip-text">{children}</span>
      {remove}
    </span>
  );
}
