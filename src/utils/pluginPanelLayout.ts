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

export interface LeftRailVisibilityInput {
  flowMode: boolean;
  sessionListCollapsed: boolean;
  gitPanelOpen: boolean;
  fileExplorerOpen: boolean;
  searchPanelOpen: boolean;
  processPanelOpen: boolean;
  hasActiveSession: boolean;
  /** Id of the open plugin panel, if any (left or bottom). */
  activePluginPanel: string | null;
  /** True when `activePluginPanel` is a registered left-side panel. */
  activePluginPanelIsLeft: boolean;
}

export interface LeftRailVisibility {
  sessionListVisible: boolean;
  /** A left plugin panel is shown in place of the session list. */
  leftPluginPanelOpen: boolean;
  /** Git or Files is shown as a second panel beside the session list. */
  secondPanelOpen: boolean;
  /** Either of the above: a panel sized by the side-panel width. */
  sidePanelVisible: boolean;
  /** Search / Process, which keep their own width. */
  selfSizedPanelVisible: boolean;
}

/** Which left-rail columns are rendered (mirrors the render conditions in App). */
export function leftRailVisibility(i: LeftRailVisibilityInput): LeftRailVisibility {
  const railShown = !i.flowMode;
  const noPlugin = !i.activePluginPanel;
  const leftPluginPanelOpen = railShown && !!i.activePluginPanel && i.activePluginPanelIsLeft;
  const secondPanelOpen = railShown && noPlugin && ((i.gitPanelOpen && i.hasActiveSession) || i.fileExplorerOpen);
  return {
    sessionListVisible: railShown && noPlugin && !i.sessionListCollapsed && !i.processPanelOpen,
    leftPluginPanelOpen,
    secondPanelOpen,
    sidePanelVisible: leftPluginPanelOpen || secondPanelOpen,
    selfSizedPanelVisible: railShown && noPlugin && (i.processPanelOpen || i.searchPanelOpen),
  };
}

/** Narrowest the chat + workbench area may get while left panels are open. */
export const MIN_MAIN_AREA_WIDTH_PX = 320;
/** CSS `min-width` of the Git / Files panels; the side panel is not squeezed below it
 *  until the session list has given up all its width. */
const SIDE_PANEL_FLOOR_PX = 200;

/**
 * Effective session-list and side-panel widths for the current window.
 *
 * The stored widths are what the user dragged to; when the window is too
 * narrow to show them and still leave `minMain` pixels for the main area,
 * they are shrunk (side panel first, then the session list, each to its
 * drag minimum, then further) until it fits.  Widths of hidden columns are
 * returned unchanged.
 */
export function fitLeftRail(
  l: LeftRailLayout,
  viewportWidth: number,
  minMain: number = MIN_MAIN_AREA_WIDTH_PX,
): { sidebarWidth: number; sidePanelWidth: number } {
  const room = Math.max(
    0,
    viewportWidth - minMain - l.activityBars - (l.selfSizedPanelVisible ? DEFAULT_SIDE_PANEL_WIDTH_PX : 0),
  );
  const w = {
    sidebar: l.sessionListVisible ? l.sidebarWidth : 0,
    side: l.sidePanelVisible ? l.sidePanelWidth : 0,
  };
  const steps: Array<[keyof typeof w, number]> = [
    ["side", MIN_SIDE_PANEL_WIDTH_PX],
    ["sidebar", MIN_SIDEBAR_WIDTH_PX],
    ["side", SIDE_PANEL_FLOOR_PX],
    ["sidebar", 0],
    ["side", 0],
  ];
  for (const [col, floor] of steps) {
    const over = w.sidebar + w.side - room;
    if (over <= 0) break;
    w[col] -= Math.max(0, Math.min(over, w[col] - floor));
  }
  return {
    sidebarWidth: l.sessionListVisible ? w.sidebar : l.sidebarWidth,
    sidePanelWidth: l.sidePanelVisible ? w.side : l.sidePanelWidth,
  };
}
