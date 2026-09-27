import { describe, it, expect } from "vitest";
import {
  DEFAULT_SIDEBAR_WIDTH_PX,
  DEFAULT_SIDE_PANEL_WIDTH_PX,
  MIN_SIDEBAR_WIDTH_PX,
  MAX_SIDEBAR_WIDTH_PX,
  MIN_SIDE_PANEL_WIDTH_PX,
  MAX_SIDE_PANEL_WIDTH_PX,
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
