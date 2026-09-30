import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import "../../styles/ui/field.css";
import "../../styles/ui/popover.css";
import { cx } from "./Button";
import { CheckGlyph, ChevronGlyph } from "./icons";
import { PAGE_SIZE, createTypeahead, firstEnabled, isPrintableKey, lastEnabled, moveBy } from "./listNav";
import { scrollIntoViewIfNeeded, usePopover } from "./usePopover";

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  /** Right-hand detail: a version, a plan, "not installed". */
  detail?: ReactNode;
  disabled?: boolean;
}

export interface SelectProps<V extends string = string> {
  options: readonly SelectOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  /** Accessible name when no visible label points at the select. */
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Shown while nothing is selected. */
  placeholder?: string;
  size?: "sm" | "md";
  /** The code font, for values such as branches. */
  code?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
}

/**
 * A select whose options can carry a status or version on the right. The
 * trigger keeps focus (combobox + aria-activedescendant); keys follow the
 * native select: Enter, Space, ↑, ↓ or Alt+↓ open; ↑ ↓ Home End PgUp PgDn
 * move; typing jumps (500 ms, repeat a letter to cycle); Enter/Space or Tab
 * commit, Esc reverts. Typing while closed changes the value, like native.
 */
export function Select<V extends string = string>({
  options,
  value,
  onChange,
  placeholder,
  size = "md",
  code,
  disabled,
  invalid,
  id,
  className,
  ...aria
}: SelectProps<V>) {
  const autoId = useId();
  const baseId = id ?? `h-select-${autoId}`;
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typeahead = useMemo(() => createTypeahead(), []);
  const items = useMemo(() => options.map((o) => ({ text: o.label, disabled: o.disabled })), [options]);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
    typeahead.reset();
  }, [typeahead]);

  const openAt = (index: number) => {
    if (disabled) return;
    setOpen(true);
    setActive(index >= 0 ? index : firstEnabled(items));
  };

  const commit = (index: number) => {
    const opt = options[index];
    if (opt && !opt.disabled && opt.value !== value) onChange(opt.value);
  };

  const style = usePopover({ open, anchorRef: triggerRef, popoverRef: listRef, onDismiss: close });

  useEffect(() => {
    if (open && active >= 0) scrollIntoViewIfNeeded(document.getElementById(`${baseId}-opt-${active}`));
  }, [open, active, baseId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const now = Date.now();
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openAt(selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : firstEnabled(items));
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        openAt(e.key === "Home" ? firstEnabled(items) : lastEnabled(items));
      } else if (isPrintableKey(e)) {
        // Like a native select: typing picks the match without opening.
        const hit = typeahead.type(e.key, items, selectedIndex, now);
        if (hit >= 0) commit(hit);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (e.altKey) return;
        setActive((a) => moveBy(items, a, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        if (e.altKey) {
          commit(active);
          close();
          return;
        }
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
        commit(active);
        close();
        return;
      case " ":
        e.preventDefault();
        if (typeahead.active(now)) {
          const hit = typeahead.type(" ", items, active, now);
          if (hit >= 0) setActive(hit);
          return;
        }
        commit(active);
        close();
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "Tab":
        // Commit and let focus move on.
        commit(active);
        close();
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
      <div
        ref={triggerRef as Ref<HTMLDivElement>}
        id={baseId}
        role="combobox"
        tabIndex={disabled ? -1 : 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        aria-disabled={disabled || undefined}
        aria-invalid={invalid || undefined}
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        aria-describedby={aria["aria-describedby"]}
        className={cx(
          "h-input",
          "h-select-trigger",
          `h-input--${size}`,
          code && "h-input--code",
          invalid && "h-input--invalid",
          disabled && "h-select-trigger--disabled",
          className,
        )}
        data-open={open || undefined}
        // The current value, the way automation reads a native select's value.
        data-value={value ?? ""}
        onClick={() => (open ? close() : openAt(selectedIndex >= 0 ? selectedIndex : firstEnabled(items)))}
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!listRef.current?.contains(e.relatedTarget as Node | null)) close();
        }}
      >
        <span className={cx("h-select-value", !selected && "h-select-value--placeholder")}>
          {selected ? selected.label : placeholder}
        </span>
        <span className="h-select-chevron">
          <ChevronGlyph />
        </span>
      </div>
      {createPortal(
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          hidden={!open}
          aria-labelledby={aria["aria-labelledby"]}
          aria-label={aria["aria-labelledby"] ? undefined : aria["aria-label"]}
          className={cx("h-popover", "h-listbox", code && "h-listbox--code")}
          style={style}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={optionId(i)}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              data-highlighted={i === active || undefined}
              data-value={o.value}
              className="h-option"
              // Keep focus on the trigger.
              onMouseDown={(e) => e.preventDefault()}
              onMouseMove={() => !o.disabled && active !== i && setActive(i)}
              onClick={() => {
                if (o.disabled) return;
                commit(i);
                close();
                triggerRef.current?.focus();
              }}
            >
              <span className="h-option-check">{o.value === value && <CheckGlyph />}</span>
              <span className="h-option-label">{o.label}</span>
              {o.detail !== undefined && <span className="h-option-detail">{o.detail}</span>}
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </>
  );
}

export interface NativeSelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: "sm" | "md";
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * A plain <select> that looks like the Select trigger. For short lists of
 * plain text (shell, scrollback, font size); the OS draws the list, the
 * same way it draws the right-click menus.
 */
export function NativeSelect({ size = "md", invalid, className, children, ref, ...rest }: NativeSelectProps) {
  return (
    <span className={cx("h-native-select", `h-native-select--${size}`, className)}>
      <select
        {...rest}
        ref={ref}
        className={cx("h-input", "h-native-select-field", `h-input--${size}`, invalid && "h-input--invalid")}
        aria-invalid={invalid || undefined}
      >
        {children}
      </select>
      <span className="h-select-chevron">
        <ChevronGlyph />
      </span>
    </span>
  );
}
