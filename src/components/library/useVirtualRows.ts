// A fixed-height window over a long list: only the rows near the viewport
// are in the DOM (about 30), and `onNearEnd` fires when the person scrolls
// within `endThreshold` rows of the end, so the next page arrives first.

import { useCallback, useEffect, useRef, useState } from "react";

export interface VirtualRows {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
  onScroll: () => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Brings row `index` into view. */
  reveal: (index: number) => void;
}

export function useVirtualRows(
  count: number,
  rowHeight: number,
  { overscan = 8, endThreshold = 10, onNearEnd }: { overscan?: number; endThreshold?: number; onNearEnd?: () => void } = {},
): VirtualRows {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const nearEnd = useRef(onNearEnd);
  nearEnd.current = onNearEnd;

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setView((v) => (v.top === el.scrollTop && v.height === el.clientHeight ? v : { top: el.scrollTop, height: el.clientHeight || 600 }));
  }, []);

  useEffect(() => {
    measure();
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const first = Math.max(0, Math.floor(view.top / rowHeight) - overscan);
  const visible = Math.ceil(view.height / rowHeight) + overscan * 2;
  const last = Math.min(count, first + visible);

  useEffect(() => {
    if (count > 0 && last >= count - endThreshold) nearEnd.current?.();
  }, [last, count, endThreshold]);

  const reveal = useCallback(
    (index: number) => {
      const el = containerRef.current;
      if (!el) return;
      const top = index * rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
    },
    [rowHeight],
  );

  return {
    start: first,
    end: last,
    padTop: first * rowHeight,
    padBottom: Math.max(0, (count - last) * rowHeight),
    onScroll: measure,
    containerRef,
    reveal,
  };
}
