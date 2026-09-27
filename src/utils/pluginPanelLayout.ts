/**
 * Sizing for the left rail.
 *
 * The session list keeps its own width (`--sidebar-w`).  Plugin panels
 * (which replace the session list) and the Git / Files sub-views (which
 * open as a second panel beside it) share a separate side-panel width
 * (`--side-panel-w`) with a wider default, because richer plugins render
 * lists plus a detail view and are cramped at the session-list width.
 * Each width has its own resize handle, so a drag moves exactly one edge.
 */

export const DEFAULT_SIDEBAR_WIDTH_PX = 240;
export const MIN_SIDEBAR_WIDTH_PX = 180;
export const MAX_SIDEBAR_WIDTH_PX = 480;

export const DEFAULT_SIDE_PANEL_WIDTH_PX = 320;
export const MIN_SIDE_PANEL_WIDTH_PX = 240;
export const MAX_SIDE_PANEL_WIDTH_PX = 600;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/** Apply a resize-handle drag delta to the session list width. */
export function resizeSidebar(width: number, delta: number): number {
  return clamp(width + delta, MIN_SIDEBAR_WIDTH_PX, MAX_SIDEBAR_WIDTH_PX, DEFAULT_SIDEBAR_WIDTH_PX);
}

/** Apply a resize-handle drag delta to the plugin / second side-panel width. */
export function resizeSidePanel(width: number, delta: number): number {
  return clamp(width + delta, MIN_SIDE_PANEL_WIDTH_PX, MAX_SIDE_PANEL_WIDTH_PX, DEFAULT_SIDE_PANEL_WIDTH_PX);
}

export interface LeftRailLayout {
  /** Width of both activity bars combined (0 in flow mode). */
  activityBars: number;
  sessionListVisible: boolean;
  sidebarWidth: number;
  sidePanelVisible: boolean;
  sidePanelWidth: number;
  /** Search / Process panels keep their own width state; counted at their
   *  default (same as the side-panel default) when open. */
  selfSizedPanelVisible: boolean;
}

/** Horizontal pixels the left rail takes away from the chat + workbench area. */
export function leftRailWidth(l: LeftRailLayout): number {
  return (
    l.activityBars +
    (l.sessionListVisible ? l.sidebarWidth : 0) +
    (l.sidePanelVisible ? l.sidePanelWidth : 0) +
    (l.selfSizedPanelVisible ? DEFAULT_SIDE_PANEL_WIDTH_PX : 0)
  );
}
