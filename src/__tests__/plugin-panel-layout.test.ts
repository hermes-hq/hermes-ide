import { describe, it, expect } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  DEFAULT_SIDE_PANEL_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDE_PANEL_WIDTH_PX,
  MAX_SIDE_PANEL_WIDTH_PX,
  MIN_MAIN_AREA_WIDTH_PX,
  fitLeftRail,
  leftRailVisibility,
  leftRailWidth,
  resizeSidebar,
  resizeSidePanel,
} from "../utils/pluginPanelLayout";

/** Replay a drag as the per-mousemove deltas PanelResizeHandle emits. */
function drag(start: number, deltas: number[], resize: (w: number, d: number) => number): number {
  return deltas.reduce(resize, start);
}

describe("side panel defaults", () => {
  it("opens plugin / second panels wider than the session list", () => {
    expect(DEFAULT_SIDE_PANEL_WIDTH_PX).toBe(320);
    expect(DEFAULT_SIDE_PANEL_WIDTH_PX).toBeGreaterThan(DEFAULT_SIDEBAR_WIDTH_PX);
  });
});

describe("resizeSidePanel", () => {
  it("responds to the very first pixel of a drag from the default (no dead zone)", () => {
    expect(resizeSidePanel(DEFAULT_SIDE_PANEL_WIDTH_PX, 1)).toBe(DEFAULT_SIDE_PANEL_WIDTH_PX + 1);
    expect(resizeSidePanel(DEFAULT_SIDE_PANEL_WIDTH_PX, -1)).toBe(DEFAULT_SIDE_PANEL_WIDTH_PX - 1);
  });

  it("tracks the cursor 1:1 within bounds", () => {
    expect(drag(DEFAULT_SIDE_PANEL_WIDTH_PX, [5, 10, 15, -7], resizeSidePanel)).toBe(DEFAULT_SIDE_PANEL_WIDTH_PX + 23);
  });

  it("clamps to its own min and max", () => {
    expect(resizeSidePanel(DEFAULT_SIDE_PANEL_WIDTH_PX, -1000)).toBe(MIN_SIDE_PANEL_WIDTH_PX);
    expect(resizeSidePanel(DEFAULT_SIDE_PANEL_WIDTH_PX, 1000)).toBe(MAX_SIDE_PANEL_WIDTH_PX);
  });

  it("falls back to the default on non-finite input", () => {
    expect(resizeSidePanel(Number.NaN, 10)).toBe(DEFAULT_SIDE_PANEL_WIDTH_PX);
  });
});

describe("resizeSidebar", () => {
  it("tracks the cursor 1:1 and clamps to the session list bounds", () => {
    expect(drag(DEFAULT_SIDEBAR_WIDTH_PX, [1, 2, 3], resizeSidebar)).toBe(DEFAULT_SIDEBAR_WIDTH_PX + 6);
    expect(resizeSidebar(DEFAULT_SIDEBAR_WIDTH_PX, -1000)).toBe(MIN_SIDEBAR_WIDTH_PX);
    expect(resizeSidebar(DEFAULT_SIDEBAR_WIDTH_PX, 1000)).toBe(MAX_SIDEBAR_WIDTH_PX);
  });
});

describe("leftRailWidth (workbench budget)", () => {
  const base = {
    activityBars: 72,
    sessionListVisible: true,
    sidebarWidth: 240,
    sidePanelVisible: false,
    sidePanelWidth: 320,
    selfSizedPanelVisible: false,
  };

  it("counts only the session list when no side panel is open", () => {
    expect(leftRailWidth(base)).toBe(72 + 240);
  });

  it("adds the Git / Files panel beside the session list", () => {
    expect(leftRailWidth({ ...base, sidePanelVisible: true })).toBe(72 + 240 + 320);
  });

  it("counts a plugin panel that replaces the session list at its own width", () => {
    expect(leftRailWidth({ ...base, sessionListVisible: false, sidePanelVisible: true, sidePanelWidth: 400 })).toBe(72 + 400);
  });

  it("counts a Search / Process panel at its default width", () => {
    expect(leftRailWidth({ ...base, selfSizedPanelVisible: true })).toBe(72 + 240 + DEFAULT_SIDE_PANEL_WIDTH_PX);
  });

  it("is just the activity bars when every panel is closed", () => {
    expect(leftRailWidth({ ...base, sessionListVisible: false })).toBe(72);
  });
});

describe("leftRailVisibility", () => {
  const closed = {
    flowMode: false,
    sessionListCollapsed: false,
    gitPanelOpen: false,
    fileExplorerOpen: false,
    searchPanelOpen: false,
    processPanelOpen: false,
    hasActiveSession: true,
    activePluginPanel: null,
    activePluginPanelIsLeft: false,
  };

  it("shows only the session list by default", () => {
    expect(leftRailVisibility(closed)).toEqual({
      sessionListVisible: true,
      leftPluginPanelOpen: false,
      secondPanelOpen: false,
      sidePanelVisible: false,
      selfSizedPanelVisible: false,
    });
  });

  it("opens Git beside the session list only when a session is active", () => {
    const withGit = leftRailVisibility({ ...closed, gitPanelOpen: true });
    expect(withGit.sessionListVisible).toBe(true);
    expect(withGit.sidePanelVisible).toBe(true);
    expect(leftRailVisibility({ ...closed, gitPanelOpen: true, hasActiveSession: false }).sidePanelVisible).toBe(false);
  });

  it("opens Files beside the session list even without an active session", () => {
    const files = leftRailVisibility({ ...closed, fileExplorerOpen: true, hasActiveSession: false });
    expect(files.secondPanelOpen).toBe(true);
    expect(files.sidePanelVisible).toBe(true);
  });

  it("replaces the session list with a left plugin panel", () => {
    const v = leftRailVisibility({ ...closed, gitPanelOpen: true, activePluginPanel: "p", activePluginPanelIsLeft: true });
    expect(v).toMatchObject({ sessionListVisible: false, leftPluginPanelOpen: true, secondPanelOpen: false, sidePanelVisible: true });
  });

  it("does not count a bottom plugin panel as a side panel", () => {
    const v = leftRailVisibility({ ...closed, activePluginPanel: "p", activePluginPanelIsLeft: false });
    expect(v.sidePanelVisible).toBe(false);
    expect(v.sessionListVisible).toBe(false);
  });

  it("treats Search as self-sized beside the list, and Process as replacing the list", () => {
    expect(leftRailVisibility({ ...closed, searchPanelOpen: true })).toMatchObject({ sessionListVisible: true, selfSizedPanelVisible: true });
    expect(leftRailVisibility({ ...closed, processPanelOpen: true })).toMatchObject({ sessionListVisible: false, selfSizedPanelVisible: true });
  });

  it("hides the whole rail in flow mode", () => {
    const v = leftRailVisibility({ ...closed, flowMode: true, gitPanelOpen: true, searchPanelOpen: true, activePluginPanel: "p", activePluginPanelIsLeft: true });
    expect(Object.values(v).every((x) => x === false)).toBe(true);
  });

  it("keeps the session list hidden when collapsed, while Git still opens", () => {
    const v = leftRailVisibility({ ...closed, sessionListCollapsed: true, gitPanelOpen: true });
    expect(v.sessionListVisible).toBe(false);
    expect(v.sidePanelVisible).toBe(true);
  });
});

describe("fitLeftRail (narrow windows)", () => {
  const twoPanels = {
    activityBars: 72,
    sessionListVisible: true,
    sidebarWidth: DEFAULT_SIDEBAR_WIDTH_PX,
    sidePanelVisible: true,
    sidePanelWidth: DEFAULT_SIDE_PANEL_WIDTH_PX,
    selfSizedPanelVisible: false,
  };
  const mainArea = (layout: typeof twoPanels, viewport: number) =>
    viewport - leftRailWidth({ ...layout, ...fitLeftRail(layout, viewport) });

  it("leaves the stored widths alone when the window is wide enough", () => {
    expect(fitLeftRail(twoPanels, 1440)).toEqual({ sidebarWidth: 240, sidePanelWidth: 320 });
  });

  it("keeps the main area usable at the smallest allowed window with Git open", () => {
    // Unfitted, the rail is 72 + 240 + 320 = 632px: wider than a 600px window.
    expect(600 - leftRailWidth(twoPanels)).toBeLessThan(0);
    expect(mainArea(twoPanels, 600)).toBeGreaterThanOrEqual(MIN_MAIN_AREA_WIDTH_PX);
  });

  it("keeps the main area at the minimum across every window width and stored size", () => {
    for (let viewport = 600; viewport <= 2000; viewport += 7) {
      for (const layout of [
        twoPanels,
        { ...twoPanels, sidebarWidth: MAX_SIDEBAR_WIDTH_PX, sidePanelWidth: MAX_SIDE_PANEL_WIDTH_PX },
        { ...twoPanels, sessionListVisible: false, sidePanelWidth: MAX_SIDE_PANEL_WIDTH_PX },
      ]) {
        expect(mainArea(layout, viewport)).toBeGreaterThanOrEqual(MIN_MAIN_AREA_WIDTH_PX);
      }
    }
  });

  it("makes the session list give way to a Search panel it cannot resize", () => {
    const withSearch = { ...twoPanels, sidePanelVisible: false, sidebarWidth: MAX_SIDEBAR_WIDTH_PX, selfSizedPanelVisible: true };
    // Once the window fits bars + Search + main, the main area keeps its minimum.
    for (let viewport = 72 + DEFAULT_SIDE_PANEL_WIDTH_PX + MIN_MAIN_AREA_WIDTH_PX; viewport <= 2000; viewport += 7) {
      expect(mainArea(withSearch, viewport)).toBeGreaterThanOrEqual(MIN_MAIN_AREA_WIDTH_PX);
    }
    // Below that, the session list takes none of the remaining space.
    expect(fitLeftRail(withSearch, 600).sidebarWidth).toBe(0);
  });

  it("shrinks the side panel to its minimum before touching the session list", () => {
    // Room for the two columns: 900 - 320 - 72 = 508 = 240 + 268.
    expect(fitLeftRail({ ...twoPanels, sidePanelWidth: 500 }, 900)).toEqual({ sidebarWidth: 240, sidePanelWidth: 268 });
    // Room 440: side panel hits 240, session list gives the remaining 40.
    expect(fitLeftRail(twoPanels, 832)).toEqual({ sidebarWidth: 200, sidePanelWidth: MIN_SIDE_PANEL_WIDTH_PX });
  });

  it("keeps Git / Files at their 200px CSS floor while the session list gives way", () => {
    // Room 208 at the 600px minimum window: below both drag minimums.
    expect(fitLeftRail(twoPanels, 600)).toEqual({ sidebarWidth: 8, sidePanelWidth: 200 });
  });

  it("never widens a panel past its stored width", () => {
    expect(fitLeftRail({ ...twoPanels, sidebarWidth: 180, sidePanelWidth: 240 }, 3000)).toEqual({ sidebarWidth: 180, sidePanelWidth: 240 });
  });

  it("returns hidden columns' stored widths untouched", () => {
    const fitted = fitLeftRail({ ...twoPanels, sessionListVisible: false, sidePanelVisible: false }, 600);
    expect(fitted).toEqual({ sidebarWidth: 240, sidePanelWidth: 320 });
  });

  it("widens back to the stored size when the window grows again", () => {
    expect(fitLeftRail(twoPanels, 700).sidePanelWidth).toBeLessThan(320);
    expect(fitLeftRail(twoPanels, 1200)).toEqual({ sidebarWidth: 240, sidePanelWidth: 320 });
  });

  it("feeds the fitted widths into the chat + workbench budget", () => {
    const fitted = { ...twoPanels, ...fitLeftRail(twoPanels, 700) };
    expect(leftRailWidth(fitted)).toBe(700 - MIN_MAIN_AREA_WIDTH_PX);
    expect(leftRailWidth(fitted)).toBeLessThan(leftRailWidth(twoPanels));
  });
});
