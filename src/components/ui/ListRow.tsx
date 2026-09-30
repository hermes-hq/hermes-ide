import type { HTMLAttributes, Ref } from "react";
import "../../styles/ui/row.css";
import { cx } from "./Button";

export interface ListRowProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * sm: one line, 32 px (command palette). lg: two lines, 44 px (attention
   * inbox). Left out, the row takes the height of what it holds (a
   * sidebar session).
   */
  size?: "sm" | "lg";
  /** Where the keyboard or the pointer is: the hover fill. */
  highlighted?: boolean;
  /** The thing you are on now (the session in view): --row-active-bg and the 2 px brass rail. */
  current?: boolean;
  ref?: Ref<HTMLDivElement>;
}

/**
 * A row of a list, a listbox or the sidebar. Highlight is the quiet hover
 * fill; the current row is filled with --row-active-bg and carries a brass
 * rail on its left, so it is never marked by colour alone. A row that is
 * both keeps the current fill and adds a hairline, so its text keeps its
 * contrast. Pass role, ids and handlers as on a div.
 */
export function ListRow({ size, highlighted, current, className, ref, ...rest }: ListRowProps) {
  return (
    <div
      {...rest}
      ref={ref}
      className={cx("h-row", size && `h-row--${size}`, className)}
      data-highlighted={highlighted || undefined}
      data-current={current || undefined}
    />
  );
}
