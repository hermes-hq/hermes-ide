/**
 * Regression tests for #316 / #318: on Windows, minimizing moves the window to
 * (-32000, -32000). That position was persisted and restored on next launch,
 * so the window opened off-screen ("vanished").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setSetting = vi.fn(() => Promise.resolve());
vi.mock("../api/settings", () => ({ setSetting: (...a: unknown[]) => setSetting(...(a as [])) }));

const monitor = {
  name: "primary",
  size: { width: 1920, height: 1080 },
  position: { x: 0, y: 0 },
  workArea: { size: { width: 1920, height: 1040 }, position: { x: 0, y: 0 } },
  scaleFactor: 1,
};

let movedHandler: (() => void) | null = null;
const win = {
  setSize: vi.fn(() => Promise.resolve()),
  setPosition: vi.fn(() => Promise.resolve()),
  onResized: vi.fn(),
  onMoved: vi.fn((cb: () => void) => {
    movedHandler = cb;
  }),
  isMinimized: vi.fn(() => Promise.resolve(false)),
  innerSize: vi.fn(() => Promise.resolve({ width: 0, height: 0 })),
  outerPosition: vi.fn(() => Promise.resolve({ x: -32000, y: -32000 })),
  scaleFactor: vi.fn(() => Promise.resolve(1)),
};
const availableMonitors = vi.fn(() => Promise.resolve([monitor]));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
  availableMonitors: () => availableMonitors(),
}));
vi.mock("@tauri-apps/api/dpi", () => ({
  LogicalSize: class {
    constructor(
      public width: number,
      public height: number,
    ) {}
  },
  LogicalPosition: class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  },
}));

import { restoreWindowState } from "../utils/windowState";

describe("restoreWindowState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availableMonitors.mockImplementation(() => Promise.resolve([monitor]));
  });

  it("ignores the Windows minimized sentinel position (-32000, -32000)", async () => {
    await restoreWindowState({ window_width: "1200", window_height: "800", window_x: "-32000", window_y: "-32000" });
    expect(win.setPosition).not.toHaveBeenCalled();
    expect(win.setSize).toHaveBeenCalled();
  });

  it("ignores a position that is off every connected monitor", async () => {
    await restoreWindowState({ window_width: "1200", window_height: "800", window_x: "5000", window_y: "200" });
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("ignores the minimized sentinel saved at 150% scale (-32000 / 1.5 = -21333)", async () => {
    await restoreWindowState({ window_width: "1200", window_height: "800", window_x: "-21333", window_y: "-21333" });
    expect(availableMonitors).not.toHaveBeenCalled();
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("does not restore any position when the monitor list is unavailable", async () => {
    availableMonitors.mockImplementation(() => Promise.reject(new Error("no monitors")));
    await restoreWindowState({ window_width: "1200", window_height: "800", window_x: "100", window_y: "50" });
    expect(win.setPosition).not.toHaveBeenCalled();
    expect(win.setSize).toHaveBeenCalled();
  });

  it("ignores the sentinel even when the monitor list is unavailable", async () => {
    availableMonitors.mockImplementation(() => Promise.reject(new Error("no monitors")));
    await restoreWindowState({ window_width: "1200", window_height: "800", window_x: "-32000", window_y: "-32000" });
    expect(win.setPosition).not.toHaveBeenCalled();
  });

  it("restores a position that is visible on a monitor", async () => {
    await restoreWindowState({ window_width: "1200", window_height: "800", window_x: "100", window_y: "50" });
    expect(win.setPosition).toHaveBeenCalledTimes(1);
    expect(win.setPosition).toHaveBeenCalledWith(expect.objectContaining({ x: 100, y: 50 }));
  });
});

describe("window state tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not persist geometry while the window is minimized", async () => {
    await restoreWindowState({});
    win.isMinimized.mockImplementation(() => Promise.resolve(true));
    movedHandler?.();
    await vi.advanceTimersByTimeAsync(600);
    expect(setSetting).not.toHaveBeenCalled();
  });
});
