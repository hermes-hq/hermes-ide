import { useEffect, useId, useRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import "../../styles/ui/choice.css";
import { cx } from "./Button";

interface ChoiceText {
  /** The visible label; the row it makes is at least 32 px tall. */
  label: ReactNode;
  /** A second, quieter line under the label. */
  description?: ReactNode;
}

function ChoiceLabel({ id, descriptionId, label, description }: ChoiceText & { id: string; descriptionId?: string }) {
  return (
    <span className="h-choice-text">
      <span id={id} className="h-choice-label">
        {label}
      </span>
      {description && (
        <span id={descriptionId} className="h-choice-description">
          {description}
        </span>
      )}
    </span>
  );
}

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "onChange" | "checked">,
    ChoiceText {
  checked: boolean;
  /** Some but not all of a group are on (a bar instead of a check). */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
}

/** For picking items and for consent. Settings on/off use Toggle. */
export function Checkbox({ checked, indeterminate = false, onChange, label, description, className, disabled, ...rest }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  const labelId = useId();
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className={cx("h-choice", disabled && "h-choice--disabled", className)}>
      <input
        {...rest}
        ref={ref}
        type="checkbox"
        className="h-checkbox"
        checked={checked}
        disabled={disabled}
        aria-checked={indeterminate ? "mixed" : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
      <ChoiceLabel id={labelId} label={label} description={description} />
    </label>
  );
}

export interface ToggleProps extends ChoiceText {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** On/off that takes effect at once (every Settings boolean). role=switch. */
export function Toggle({ checked, onChange, label, description, disabled, id, className }: ToggleProps) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <label className={cx("h-choice", "h-choice--toggle", disabled && "h-choice--disabled", className)}>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        className="h-toggle"
        onClick={() => onChange(!checked)}
      >
        <span className="h-toggle-knob" aria-hidden="true" />
      </button>
      <ChoiceLabel id={labelId} descriptionId={descriptionId} label={label} description={description} />
    </label>
  );
}

export interface RadioOption<V extends string = string> extends ChoiceText {
  value: V;
  disabled?: boolean;
}

export interface RadioGroupProps<V extends string = string> {
  /** Accessible name of the group. */
  label: string;
  name?: string;
  options: readonly RadioOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  className?: string;
}

/**
 * One choice out of a few, each with room for a description. One tab stop;
 * the arrow keys move and select (wrapping), the same in every engine.
 */
export function RadioGroup<V extends string = string>({ label, name, options, value, onChange, className }: RadioGroupProps<V>) {
  const autoName = useId();
  const groupName = name ?? autoName;
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const current = options.findIndex((o) => o.value === value);
  const tabStop = current >= 0 && !options[current].disabled ? current : options.findIndex((o) => !o.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, i: number) => {
    const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    for (let k = 1; k <= options.length; k++) {
      const j = (i + dir * k + options.length) % options.length;
      if (options[j].disabled) continue;
      refs.current[j]?.focus();
      if (options[j].value !== value) onChange(options[j].value);
      return;
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx("h-radio-group", className)}>
      {options.map((o, i) => (
        <Radio
          key={o.value}
          inputRef={(el) => {
            refs.current[i] = el;
          }}
          name={groupName}
          value={o.value}
          checked={o.value === value}
          disabled={o.disabled}
          tabIndex={i === tabStop ? 0 : -1}
          label={o.label}
          description={o.description}
          onChange={() => onChange(o.value)}
          onKeyDown={(e) => onKeyDown(e, i)}
        />
      ))}
    </div>
  );
}

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type">, ChoiceText {
  inputRef?: (el: HTMLInputElement | null) => void;
}

/** A single radio; use RadioGroup unless the radios are laid out apart. */
export function Radio({ label, description, className, disabled, inputRef, ...rest }: RadioProps) {
  const labelId = useId();
  return (
    <label className={cx("h-choice", disabled && "h-choice--disabled", className)}>
      <input {...rest} ref={inputRef} type="radio" className="h-radio" disabled={disabled} />
      <ChoiceLabel id={labelId} label={label} description={description} />
    </label>
  );
}
