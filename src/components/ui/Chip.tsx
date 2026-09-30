import type { ReactNode, Ref } from "react";
import "../../styles/ui/chip.css";
import type { ControlAttrs } from "./attrs";
import { cx } from "./Button";
import { ChevronGlyph, CloseGlyph } from "./icons";

interface ChipBase {
  children: ReactNode;
  /** md (28 px) by default, sm (24). */
  size?: "sm" | "md";
  /** danger: the value is a risky one (e.g. an approval mode that never asks). */
  tone?: "neutral" | "danger";
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
  /**
   * The chip opens a panel of choices for its value instead of being on or
   * off: `selected` is then whether that panel is open (aria-expanded, not
   * aria-pressed) and the chip ends with a chevron.
   */
  expands?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  /** Hook class, id, tooltip and data-* attributes for the chip's button. */
  buttonAttrs?: ControlAttrs;
}

type Removable =
  | { onRemove?: undefined; removeLabel?: undefined }
  /** A trailing × removes the chip; its accessible name is required. */
  | { onRemove: () => void; removeLabel: string };

export type ChipProps = (StaticChip | ToggleChip) & Removable;

/**
 * A compact value: a model, a filter, a scope. Neutral by default; a
 * selectable chip turns brass when on; a chip that opens its choices shows
 * a chevron and turns brass while they are open; a removable chip ends with
 * a small ×.
 */
export function Chip(props: ChipProps) {
  const { children, size = "md", tone = "neutral", className } = props;
  const toggle = props.onToggle !== undefined;
  const classes = cx(
    "h-chip",
    `h-chip--${size}`,
    tone === "danger" && "h-chip--danger",
    toggle && props.selected && "h-chip--selected",
    className,
  );
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
    const { className: hook, ...attrs } = p.buttonAttrs ?? {};
    return (
      <span className={cx(classes, "h-chip--interactive")}>
        <button
          {...attrs}
          ref={p.buttonRef}
          type="button"
          className={cx("h-chip-button", hook)}
          aria-pressed={p.expands ? undefined : p.selected}
          aria-expanded={p.expands ? p.selected : undefined}
          disabled={p.disabled}
          onClick={() => p.onToggle(!p.selected)}
        >
          <span className="h-chip-text">{children}</span>
          {p.expands && (
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
    <span className={classes}>
      <span className="h-chip-label h-chip-text">{children}</span>
      {remove}
    </span>
  );
}
