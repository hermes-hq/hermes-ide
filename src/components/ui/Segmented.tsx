import { useRef, type KeyboardEvent, type ReactNode } from "react";
import "../../styles/ui/segmented.css";
import type { ControlAttrs } from "./attrs";
import { cx } from "./Button";

export interface SegmentOption<V extends string = string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  /** Hook class, id, tooltip and data-* attributes for the segment's button. */
  attrs?: ControlAttrs;
}

export interface SegmentedProps<V extends string = string> {
  options: readonly SegmentOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  /** md (32 px) by default, sm (28). */
  size?: "sm" | "md";
  className?: string;
}

/** Index of the next enabled option, wrapping around. */
function step<V extends string>(options: readonly SegmentOption<V>[], from: number, dir: 1 | -1): number {
  for (let k = 1; k <= options.length; k++) {
    const i = (from + dir * k + options.length) % options.length;
    if (!options[i].disabled) return i;
  }
  return from;
}

/**
 * One value out of two to five: "By file / By turn". A radio group with one
 * tab stop; arrow keys move and select, Home/End jump. The selected segment
 * is a raised keycap in a recessed well.
 */
export function Segmented<V extends string = string>({ options, value, onChange, label, size = "md", className }: SegmentedProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = options.findIndex((o) => o.value === value);
  const tabStop = current >= 0 && !options[current].disabled ? current : options.findIndex((o) => !o.disabled);

  const select = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    if (opt.value !== value) onChange(opt.value);
    refs.current[i]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = step(options, i, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = step(options, i, -1);
    else if (e.key === "Home") next = step(options, -1, 1);
    else if (e.key === "End") next = step(options, options.length, -1);
    if (next === null) return;
    e.preventDefault();
    select(next);
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx("h-segmented", `h-segmented--${size}`, className)}>
      {options.map((o, i) => (
        <button
          {...o.attrs}
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          className={cx("h-segment", o.attrs?.className)}
          onClick={() => select(i)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
