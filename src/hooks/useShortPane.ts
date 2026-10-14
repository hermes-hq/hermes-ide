// ─── A short terminal pane gives its rows back ────────────────────────
//
// An agent's own interface (Claude Code's footer, Codex's status line)
// drops lines when its terminal has too few rows, and on a short pane
// Hermes's chrome took them: the pane header, the session action bar and
// the turn bar each had a row of their own. Below SHORT_PANE_ROWS terminal
// rows the action bar and the turn bar fold into the header line (the bar
// collapsed, the turn bar as one chip), and come back when the pane is
// tall again.
//
// Measured on the pane, not the window. The decision reads the pane's
// height against what the chrome takes in the normal layout (measured while
// it is shown, so folding never flips it back), with one row of hysteresis.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getTerminal } from "../terminal/TerminalPool";

/** Fewer terminal rows than this in the normal layout: the chrome folds. */
export const SHORT_PANE_ROWS = 18;
/** The chrome's height before it was ever measured (header, bar, turn bar). */
const DEFAULT_CHROME_PX = 96;
const DEFAULT_CELL_PX = 17;

/** Pure: whether the pane is short, given its height, the normal chrome and a row's height. */
export function isShortPane(paneHeight: number, chromePx: number, cellPx: number, wasShort: boolean): boolean {
  if (paneHeight <= 0 || cellPx <= 0) return false;
  const rows = Math.floor((paneHeight - chromePx) / cellPx);
  return wasShort ? rows < SHORT_PANE_ROWS + 1 : rows < SHORT_PANE_ROWS;
}

/** Test builds only: a scenario turns the folding off to measure the rows it gives back. */
function foldingOffForTest(): boolean {
  return import.meta.env.VITE_HERMES_E2E === "1" && (window as { __HERMES_E2E_NO_FOLD__?: boolean }).__HERMES_E2E_NO_FOLD__ === true;
}

/** The height of one terminal row in this session (px), from the terminal itself when it is drawn. */
function cellHeight(sessionId: string): number {
  const term = getTerminal(sessionId) as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } } | null;
  const h = term?._core?._renderService?.dimensions?.css?.cell?.height;
  return typeof h === "number" && h > 0 ? h : DEFAULT_CELL_PX;
}

export function useShortPane(paneRef: RefObject<HTMLElement | null>, sessionId: string, enabled: boolean): boolean {
  const [short, setShort] = useState(false);
  const chrome = useRef(DEFAULT_CHROME_PX);
  const shortRef = useRef(false);
  shortRef.current = short;

  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane || !enabled) {
      setShort(false);
      return;
    }
    const update = () => {
      const height = pane.clientHeight;
      if (!shortRef.current) {
        // Normal layout: learn what the chrome takes now.
        const terminal = pane.querySelector<HTMLElement>(".split-pane-terminal");
        if (terminal && terminal.clientHeight > 0) chrome.current = Math.max(0, height - terminal.clientHeight);
      }
      setShort(!foldingOffForTest() && isShortPane(height, chrome.current, cellHeight(sessionId), shortRef.current));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    // The chrome changes too (a turn bar appears): the terminal's height tells.
    const terminal = pane.querySelector(".split-pane-terminal");
    if (terminal) ro.observe(terminal);
    return () => ro.disconnect();
  }, [paneRef, sessionId, enabled]);

  return enabled && short;
}
