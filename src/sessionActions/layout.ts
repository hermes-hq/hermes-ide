// ─── Session actions: fitting the bar into its pane ───────────────────
//
// Measured, never wrapped out of sight: the bar first shows every chip
// with its label; when that overflows its row it shows the chips as glyphs
// (the label in the tooltip); when that overflows too, or the pane is
// narrower than COLLAPSE_BELOW, it collapses to the Prompts glyph, the
// state chip and a "/ N" button that opens the Commands list (where the
// pinned chips are the first section). Three narrow panes side by side stay
// clean.
//
// How wide each form needs to be is learnt from the row itself: a form
// that overflowed records the width it wanted, so widening the pane brings
// the fuller form back once it fits, and a change in what the bar shows
// starts over from the full form.

import { useLayoutEffect, useReducer, useRef, useState, type RefObject } from "react";

export type BarLayout = "full" | "icons" | "collapsed";

/** Below this width (px) the bar is always collapsed. */
export const COLLAPSE_BELOW = 480;

export interface LayoutNeeds {
  full?: number;
  icons?: number;
}

/** Pure: the fullest form that fits `width` given what each form needed so far. */
export function pickLayout(width: number, needs: LayoutNeeds, forceCollapsed = false): BarLayout {
  if (forceCollapsed) return "collapsed";
  // Not laid out yet (width 0): the full form, measured on the next frame.
  if (width > 0 && width < COLLAPSE_BELOW) return "collapsed";
  if (needs.full === undefined || width === 0 || needs.full <= width) return "full";
  if (needs.icons === undefined || needs.icons <= width) return "icons";
  return "collapsed";
}

/**
 * The form the bar takes in its row. `signature` names what the bar shows
 * (its chips and their labels): when it changes, the measuring starts over.
 */
export function useBarLayout(rowRef: RefObject<HTMLElement | null>, signature: string, forceCollapsed: boolean): BarLayout {
  const [width, setWidth] = useState(0);
  const needs = useRef<LayoutNeeds>({});
  const measuredFor = useRef(signature);
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  if (measuredFor.current !== signature) {
    measuredFor.current = signature;
    needs.current = {};
  }

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [rowRef]);

  const layout = pickLayout(width, needs.current, forceCollapsed);

  // After each render in a form that can overflow: did it?
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || layout === "collapsed" || width === 0) return;
    if (el.scrollWidth > el.clientWidth + 1) {
      // More than the width last read, which can be stale (the row shrank
      // before the observer said so): the next pick always moves on.
      needs.current = { ...needs.current, [layout]: Math.max(el.scrollWidth, width + 1) };
      remeasure();
    }
  });

  return layout;
}
