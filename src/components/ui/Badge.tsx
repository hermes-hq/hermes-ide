import type { ReactNode } from "react";
import "../../styles/ui/badge.css";
import { cx } from "./Button";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info";

/** A short status word ("EXACT", "RETIRED"). 18 px, 10 px caps — nothing smaller. */
export function Badge({ tone = "neutral", children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={cx("h-badge", `h-badge--${tone}`, className)}>{children}</span>;
}

export interface CounterProps {
  value: number;
  /** Above this the counter shows "max+". */
  max?: number;
  /** neutral by default; attention (brass) only when the count needs you. */
  tone?: "neutral" | "attention";
  /**
   * What the number counts, for screen readers ("3 agents need you"). The
   * digits themselves are hidden from them when this is given.
   */
  label?: string;
  className?: string;
}

export function Counter({ value, max = 99, tone = "neutral", label, className }: CounterProps) {
  const text = value > max ? `${max}+` : String(value);
  return (
    <span className={cx("h-counter", `h-counter--${tone}`, className)}>
      <span aria-hidden={label ? true : undefined}>{text}</span>
      {label && <span className="h-visually-hidden">{label}</span>}
    </span>
  );
}
