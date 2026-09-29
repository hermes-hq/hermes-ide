import { useId, type InputHTMLAttributes, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";
import "../../styles/ui/field.css";
import { cx } from "./Button";

interface FieldExtras {
  /** Paths, branches, commands: the code font at 12 px. */
  code?: boolean;
  /** Marks the value as wrong: danger edge and aria-invalid. */
  invalid?: boolean;
  /**
   * What is wrong, shown under the field and linked to it with
   * aria-describedby (implies `invalid`).
   */
  error?: ReactNode;
}

function describedBy(own: string | undefined, errorId: string | undefined): string | undefined {
  const ids = [own, errorId].filter(Boolean).join(" ");
  return ids || undefined;
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size">, FieldExtras {
  /** md (32 px) by default; sm (28) for a toolbar search. */
  size?: "sm" | "md";
  ref?: Ref<HTMLInputElement>;
}

export function Input({ size = "md", code, invalid, error, className, type = "text", ref, ...rest }: InputProps) {
  const errorId = useId();
  const isInvalid = invalid || !!error;
  const input = (
    <input
      {...rest}
      ref={ref}
      type={type}
      className={cx("h-input", `h-input--${size}`, code && "h-input--code", isInvalid && "h-input--invalid", className)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedBy(rest["aria-describedby"], error ? errorId : undefined)}
    />
  );
  if (!error) return input;
  return (
    <span className="h-field">
      {input}
      <span id={errorId} className="h-field-error">
        {error}
      </span>
    </span>
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement>, FieldExtras {
  ref?: Ref<HTMLTextAreaElement>;
}

export function Textarea({ code, invalid, error, className, ref, ...rest }: TextareaProps) {
  const errorId = useId();
  const isInvalid = invalid || !!error;
  const textarea = (
    <textarea
      {...rest}
      ref={ref}
      className={cx("h-input", "h-textarea", code && "h-input--code", isInvalid && "h-input--invalid", className)}
      aria-invalid={isInvalid || undefined}
      aria-describedby={describedBy(rest["aria-describedby"], error ? errorId : undefined)}
    />
  );
  if (!error) return textarea;
  return (
    <span className="h-field">
      {textarea}
      <span id={errorId} className="h-field-error">
        {error}
      </span>
    </span>
  );
}
