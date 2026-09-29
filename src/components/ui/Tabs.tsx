import { useRef, type KeyboardEvent, type ReactNode } from "react";
import "../../styles/ui/tabs.css";
import { cx } from "./Button";

export interface TabItem<V extends string = string> {
  value: V;
  label: string;
  /** Something small after the label, e.g. a Counter. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<V extends string = string> {
  /**
   * Prefix for the tab and panel ids. Render one <TabPanel idPrefix=…> for
   * the selected tab only: the selected tab alone points at its panel
   * (aria-controls), so no tab names a panel that is not in the page.
   */
  idPrefix: string;
  tabs: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** horizontal: a brass rail under the selected tab. vertical (Settings nav): a rail on the left. */
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export const tabId = (prefix: string, value: string) => `${prefix}-tab-${value}`;
export const tabPanelId = (prefix: string, value: string) => `${prefix}-panel-${value}`;

/**
 * Switches between views of one surface. One tab stop; the arrow keys of
 * the orientation move and select at once (automatic activation), Home/End
 * jump. Different from Segmented, which picks a value inside a view.
 */
export function Tabs<V extends string = string>({
  idPrefix,
  tabs,
  value,
  onChange,
  label,
  orientation = "horizontal",
  className,
}: TabsProps<V>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = tabs.findIndex((t) => t.value === value);

  const move = (from: number, dir: 1 | -1): number => {
    for (let k = 1; k <= tabs.length; k++) {
      const i = (from + dir * k + tabs.length) % tabs.length;
      if (!tabs[i].disabled) return i;
    }
    return from;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const [prev, next] = orientation === "vertical" ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    let target: number | null = null;
    if (e.key === next) target = move(i, 1);
    else if (e.key === prev) target = move(i, -1);
    else if (e.key === "Home") target = move(-1, 1);
    else if (e.key === "End") target = move(tabs.length, -1);
    if (target === null) return;
    e.preventDefault();
    refs.current[target]?.focus();
    if (tabs[target].value !== value) onChange(tabs[target].value);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      className={cx("h-tabs", `h-tabs--${orientation}`, className)}
    >
      {tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={tabId(idPrefix, t.value)}
          type="button"
          role="tab"
          aria-selected={t.value === value}
          aria-controls={t.value === value ? tabPanelId(idPrefix, t.value) : undefined}
          tabIndex={i === current ? 0 : -1}
          disabled={t.disabled}
          className="h-tab"
          onClick={() => t.value !== value && onChange(t.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          <span className="h-tab-label">{t.label}</span>
          {t.badge}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  value,
  children,
  className,
}: {
  idPrefix: string;
  value: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div role="tabpanel" id={tabPanelId(idPrefix, value)} aria-labelledby={tabId(idPrefix, value)} tabIndex={0} className={className}>
      {children}
    </div>
  );
}
