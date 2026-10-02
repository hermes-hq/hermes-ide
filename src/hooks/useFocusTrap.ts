import { useEffect, type RefObject } from "react";

// A modal that is modal for the keyboard too: while it is open, Tab and
// Shift+Tab wrap around inside it, and everything else on the page is inert
// (no Tab stop, no click, hidden from screen readers), so neither the
// keyboard nor a screen reader can wander into the app behind it.

const TABBABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type='hidden']), select:not([disabled]), textarea:not([disabled]), [tabindex]";

/** The elements Tab stops at inside `root`, in order. */
export function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => {
    if (el.tabIndex < 0 || el.closest("[inert]")) return false;
    // Hidden (display: none on it or an ancestor) or not laid out.
    if (el.getClientRects().length === 0 && el !== document.activeElement) return false;
    return getComputedStyle(el).visibility !== "hidden";
  });
}

/** Marks every element outside `root` inert; returns how to undo it. */
function makeOutsideInert(root: HTMLElement): () => void {
  const changed: HTMLElement[] = [];
  let node: HTMLElement | null = root;
  while (node && node !== document.body && node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.inert || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      sibling.inert = true;
      changed.push(sibling);
    }
    node = node.parentElement;
  }
  return () => {
    for (const el of changed) el.inert = false;
  };
}

/**
 * Keeps the keyboard inside `ref` while `active`: Tab past the last control
 * goes to the first, Shift+Tab before the first to the last, and the rest of
 * the page is inert.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const restore = makeOutsideInert(root);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented) return;
      const stops = tabbablesIn(root);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement as HTMLElement | null;
      const inside = !!at && root.contains(at);
      if (e.shiftKey && (!inside || at === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || at === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      restore();
    };
  }, [ref, active]);
}
