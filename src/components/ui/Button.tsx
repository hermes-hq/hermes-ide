import type { ButtonHTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import "../../styles/ui/button.css";
import { CloseGlyph } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger" | "danger-solid" | "link";
export type ControlSize = "sm" | "md" | "lg";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /**
   * primary: brass, at most one per surface (right-most in a footer).
   * secondary: the default. quiet: no fill until hovered. danger: a
   * destructive action next to others. danger-solid: only as the primary
   * of a confirm dialog. link: an inline "Sign in" / "Check again".
   */
  variant?: ButtonVariant;
  /** md (32 px) by default; sm (28) in dense chrome, lg (36) on the welcome / empty state. */
  size?: ControlSize;
  /** Shows progress and ignores presses; the label stays so the width does not jump. */
  loading?: boolean;
  /** Icon before the label. */
  icon?: ReactNode;
  /** Icon after the label. */
  iconEnd?: ReactNode;
  type?: "button" | "submit" | "reset";
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  iconEnd,
  type = "button",
  className,
  children,
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx("h-btn", `h-btn--${variant}`, `h-btn--${size}`, loading && "h-btn--loading", className)}
      aria-busy={loading || undefined}
      aria-disabled={loading || rest["aria-disabled"] || undefined}
      onClick={handleClick}
    >
      {icon && <span className="h-btn-icon">{icon}</span>}
      {children !== undefined && children !== null && <span className="h-btn-label">{children}</span>}
      {iconEnd && <span className="h-btn-icon">{iconEnd}</span>}
      {loading && <span className="h-btn-progress" aria-hidden="true" />}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-label" | "children"> {
  /** The accessible name, also shown as the tooltip. Required: an icon has no text. */
  label: string;
  icon: ReactNode;
  /** md (32 px) by default, sm (28) in dense chrome. */
  size?: Exclude<ControlSize, "lg">;
  /** For an icon button that toggles something on and off. */
  pressed?: boolean;
  type?: "button" | "submit" | "reset";
  ref?: Ref<HTMLButtonElement>;
}

export function IconButton({ label, icon, size = "md", pressed, type = "button", className, title, ref, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx("h-icon-btn", `h-icon-btn--${size}`, className)}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
    >
      <span className="h-icon-btn-icon">{icon}</span>
    </button>
  );
}

export type CloseButtonProps = Omit<IconButtonProps, "icon" | "size">;

/** The one close button: a small icon button with a single drawn ×. */
export function CloseButton({ className, ...rest }: CloseButtonProps) {
  return <IconButton {...rest} size="sm" icon={<CloseGlyph />} className={cx("h-close-btn", className)} />;
}
