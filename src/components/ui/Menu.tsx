import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import "../../styles/ui/popover.css";
import { cx } from "./Button";
import { PAGE_SIZE, createTypeahead, firstEnabled, isPrintableKey, lastEnabled, moveBy } from "./listNav";
import { scrollIntoViewIfNeeded, usePopover } from "./usePopover";

export interface MenuAction {
  id: string;
  label: string;
  /** Shown on the right as a key hint, e.g. "⌘K". */
  shortcut?: string;
  icon?: ReactNode;
  /** A destructive action: drawn in the danger colour. */
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  id: string;
  separator: true;
}

export type MenuEntry = MenuAction | MenuSeparator;

function isSeparator(e: MenuEntry): e is MenuSeparator {
  return (e as MenuSeparator).separator === true;
}

/** Props the trigger must spread onto its button. */
export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  id: string;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  /** Accessible name of the menu (usually the trigger's label). */
  label: string;
  entries: readonly MenuEntry[];
  /** Renders the button that opens the menu, e.g. `(p) => <Button {...p}>More</Button>`. */
  renderTrigger: (props: MenuTriggerProps) => ReactNode;
  className?: string;
}

/**
 * A menu of actions (not values — use Select for those). Enter, Space or ↓
 * open it on the first item, ↑ on the last; ↑ ↓ Home End PgUp PgDn and
 * type-ahead move; Enter or Space runs the item; Esc or Tab close it and
 * focus returns to the trigger.
 */
export function Menu({ label, entries, renderTrigger, className }: MenuProps) {
  const autoId = useId();
  const baseId = `h-menu-${autoId}`;
  const menuId = `${baseId}-menu`;
  const triggerId = `${baseId}-trigger`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typeahead = useMemo(() => createTypeahead(), []);
  // Separators take part as disabled rows, so indexes match the DOM.
  const items = useMemo(
    () => entries.map((e) => (isSeparator(e) ? { text: "", disabled: true } : { text: e.label, disabled: e.disabled })),
    [entries],
  );

  const close = useCallback(
    (focusTrigger: boolean) => {
      setOpen(false);
      setActive(-1);
      typeahead.reset();
      if (focusTrigger) triggerRef.current?.focus();
    },
    [typeahead],
  );
  const dismiss = useCallback(() => close(false), [close]);
  const style = usePopover({ open, anchorRef: triggerRef, popoverRef: menuRef, onDismiss: dismiss, matchWidth: false });

  const openAt = (index: number) => {
    setOpen(true);
    setActive(index);
  };

  // Focus moves into the menu while it is open (the menu element holds it
  // and points at the active item with aria-activedescendant).
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open && active >= 0) scrollIntoViewIfNeeded(document.getElementById(`${baseId}-item-${active}`));
  }, [open, active, baseId]);

  const run = (index: number) => {
    const entry = entries[index];
    if (!entry || isSeparator(entry) || entry.disabled) return;
    close(true);
    entry.onSelect();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openAt(firstEnabled(items));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openAt(lastEnabled(items));
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const now = Date.now();
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => moveBy(items, a, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => moveBy(items, a, -1));
        return;
      case "Home":
        e.preventDefault();
        setActive(firstEnabled(items));
        return;
      case "End":
        e.preventDefault();
        setActive(lastEnabled(items));
        return;
      case "PageDown":
        e.preventDefault();
        setActive((a) => moveBy(items, a, PAGE_SIZE));
        return;
      case "PageUp":
        e.preventDefault();
        setActive((a) => moveBy(items, a, -PAGE_SIZE));
        return;
      case "Enter":
        e.preventDefault();
        run(active);
        return;
      case " ":
        e.preventDefault();
        if (typeahead.active(now)) {
          const hit = typeahead.type(" ", items, active, now);
          if (hit >= 0) setActive(hit);
          return;
        }
        run(active);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case "Tab":
        // Back on the trigger first, so Tab moves on from there.
        close(true);
        return;
      default:
        if (isPrintableKey(e)) {
          e.preventDefault();
          const hit = typeahead.type(e.key, items, active, now);
          if (hit >= 0) setActive(hit);
        }
    }
  };

  return (
    <>
      {renderTrigger({
        ref: triggerRef,
        id: triggerId,
        "aria-haspopup": "menu",
        "aria-expanded": open,
        "aria-controls": menuId,
        onClick: () => (open ? close(false) : openAt(firstEnabled(items))),
        onKeyDown: onTriggerKeyDown,
      })}
      {createPortal(
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          hidden={!open}
          aria-label={label}
          aria-activedescendant={open && active >= 0 ? `${baseId}-item-${active}` : undefined}
          className={cx("h-popover", "h-menu", className)}
          style={style}
          onKeyDown={onMenuKeyDown}
          onBlur={(e) => {
            const to = e.relatedTarget as Node | null;
            if (to && (menuRef.current?.contains(to) || triggerRef.current?.contains(to))) return;
            if (to) close(false);
          }}
        >
          {entries.map((entry, i) =>
            isSeparator(entry) ? (
              <li key={entry.id} role="separator" className="h-menu-separator" />
            ) : (
              <li
                key={entry.id}
                id={`${baseId}-item-${i}`}
                role="menuitem"
                aria-disabled={entry.disabled || undefined}
                data-highlighted={i === active || undefined}
                className={cx("h-option", "h-menu-item", entry.danger && "h-menu-item--danger")}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => !entry.disabled && active !== i && setActive(i)}
                onClick={() => run(i)}
              >
                <span className="h-option-check">{entry.icon}</span>
                <span className="h-option-label">{entry.label}</span>
                {entry.shortcut && <kbd className="h-menu-shortcut">{entry.shortcut}</kbd>}
              </li>
            ),
          )}
        </ul>,
        document.body,
      )}
    </>
  );
}
