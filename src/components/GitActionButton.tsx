import type { ButtonHTMLAttributes } from "react";
import { Button, type ButtonVariant } from "./ui/Button";

export interface GitActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "className"> {
  /** The Review Desk's Changes section: the control set's small button. */
  kit: boolean;
  /** The control-set variant (kit only). */
  variant?: ButtonVariant;
  /** Class names on the control-set button. */
  kitClass: string;
  /** Class names on the Git panel's own button. */
  legacyClass: string;
}

/**
 * One git action (Commit, Stage, Discard…): the control set's small button in
 * the Review Desk's Changes section, the Git panel's own button elsewhere.
 */
export function GitActionButton({ kit, variant, kitClass, legacyClass, children, ...rest }: GitActionButtonProps) {
  if (kit) {
    return (
      <Button {...rest} size="sm" variant={variant} className={kitClass}>
        {children}
      </Button>
    );
  }
  return (
    <button {...rest} type="button" className={legacyClass}>
      {children}
    </button>
  );
}
