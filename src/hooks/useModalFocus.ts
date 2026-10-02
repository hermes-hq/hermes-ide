import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour of a small modal confirmation:
 * - focus moves to `initial` (the confirm button) when it opens;
 * - Tab and Shift+Tab stay inside `dialog`;
 * - Escape cancels;
 * - Enter is left to the focused button (no window-wide Enter that would
 *   confirm while Cancel has focus);
 * - when it closes, focus goes back to what had it before (the × that
 *   opened it).
 */
export function useModalFocus(
  dialog: RefObject<HTMLElement | null>,
  initial: RefObject<HTMLElement | null>,
  onCancel: () => void,
): void {
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initial.current ?? dialog.current?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    const onKey = (e: KeyboardEvent) => {
      const root = dialog.current;
      if (!root) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = root.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (before && document.contains(before)) before.focus();
    };
    // Mount and unmount only: the dialog's elements do not change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
