import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

/**
 * Places a popover (listbox, menu) under its anchor with fixed positioning,
 * so a scrolling or clipping parent never cuts it off. It opens upward when
 * there is more room above, and closes on a press outside both elements.
 */
export function usePopover({
  open,
  anchorRef,
  popoverRef,
  onDismiss,
  matchWidth = true,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  matchWidth?: boolean;
}): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popoverRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const gap = 4;
    const height = pop?.offsetHeight ?? 0;
    const below = window.innerHeight - r.bottom;
    const above = r.top;
    const up = height > below - gap && above > below;
    const next: CSSProperties = {
      position: "fixed",
      left: Math.max(gap, Math.min(r.left, window.innerWidth - (pop?.offsetWidth ?? r.width) - gap)),
      ...(matchWidth ? { minWidth: r.width } : {}),
      ...(up ? { bottom: window.innerHeight - r.top + gap } : { top: r.bottom + gap }),
    };
    setStyle(next);
  }, [anchorRef, popoverRef, matchWidth]);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent | MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (anchorRef.current?.contains(t) || popoverRef.current?.contains(t))) return;
      onDismiss();
    };
    const onResize = () => place();
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, anchorRef, popoverRef, onDismiss, place]);

  return style;
}

/** Keep the active option in view (a no-op where layout does not exist, e.g. tests). */
export function scrollIntoViewIfNeeded(el: Element | null | undefined) {
  if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
    (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }
}
