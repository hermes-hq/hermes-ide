/**
 * The shared git status poller: one walk per directory at a time, and no
 * timed walks while the window is hidden.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../api/git", () => ({
  gitStatus: vi.fn(),
}));

import { gitStatus } from "../api/git";
import { subscribeGitStatus, refreshGitStatus } from "../hooks/useGitStatusCache";

const mockGitStatus = vi.mocked(gitStatus);

// Minimal document: the test env is node.
const visibilityListeners = new Set<() => void>();
const fakeDocument = {
  visibilityState: "visible" as "visible" | "hidden",
  addEventListener: (type: string, cb: () => void) => {
    if (type === "visibilitychange") visibilityListeners.add(cb);
  },
};

function setHidden(hidden: boolean) {
  fakeDocument.visibilityState = hidden ? "hidden" : "visible";
  visibilityListeners.forEach((cb) => cb());
}

const STATUS = { projects: [], timestamp: 0 };

describe("git status cache polling", () => {
  let unsubscribe: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", fakeDocument);
    fakeDocument.visibilityState = "visible";
    mockGitStatus.mockReset();
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not start a second walk while the first is still running", async () => {
    let finish: (v: typeof STATUS) => void = () => {};
    mockGitStatus.mockImplementation(() => new Promise((r) => { finish = r; }));

    unsubscribe = subscribeGitStatus("/repo/slow", "s1", () => {}, 1000);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    // Five ticks pass while the first walk is still going.
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    finish(STATUS);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });

  it("an explicit refresh during a walk runs once after it, not alongside it", async () => {
    let finish: (v: typeof STATUS) => void = () => {};
    mockGitStatus.mockImplementation(() => new Promise((r) => { finish = r; }));

    unsubscribe = subscribeGitStatus("/repo/refresh", "s1", () => {}, 60_000);
    refreshGitStatus("/repo/refresh");
    refreshGitStatus("/repo/refresh");
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    finish(STATUS);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });

  it("pauses while the window is hidden and catches up when it comes back", async () => {
    mockGitStatus.mockResolvedValue(STATUS);

    unsubscribe = subscribeGitStatus("/repo/hidden", "s1", () => {}, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockGitStatus).toHaveBeenCalledTimes(1);

    setHidden(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGitStatus).toHaveBeenCalledTimes(2);
  });
});
