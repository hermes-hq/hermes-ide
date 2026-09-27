// @vitest-environment jsdom
/**
 * N10 — "updates never kill a working agent".
 *
 * Behavioural tests against the REAL `useAutoUpdater` hook (rendered with
 * `@testing-library/react`'s `renderHook`, not a re-implemented copy of its
 * logic): while `busySessionCount > 0`, `installAndRelaunch` must be a no-op
 * unless explicitly forced; once the count drops to zero, the same call
 * must install and relaunch exactly as it always has.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

// ── Mock the Tauri plugins the hook talks to ──────────────────────────
const mockCheck = vi.fn();
const mockRelaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {},
}));
// The check runs in the backend (stable/beta channel, N05).
vi.mock("../api/updater", () => ({
  checkForUpdate: (...args: unknown[]) => mockCheck(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}));

import { useAutoUpdater } from "../hooks/useAutoUpdater";

function fakeUpdate(version = "9.9.9") {
  return {
    version,
    body: "release notes",
    download: vi.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 0 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn(async () => {}),
  };
}

describe("useAutoUpdater — N10 waits for idle sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockCheck.mockReset();
    mockRelaunch.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advances past the 5s launch-check delay and lets the effect settle. */
  async function bootAndCheck() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
  }

  it("does not install or relaunch while a session is busy", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);

    const { result, rerender } = renderHook(({ busy }: { busy: number }) => useAutoUpdater(busy), {
      initialProps: { busy: 1 },
    });

    await bootAndCheck();
    expect(result.current.state.available).toBe(true);

    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.ready).toBe(true);

    await act(async () => {
      await result.current.installAndRelaunch();
    });

    expect(update.install).not.toHaveBeenCalled();
    expect(mockRelaunch).not.toHaveBeenCalled();
    // The UI-visible busy count is threaded through to state so the dialog
    // can render the "waiting for N working agents" message.
    expect(result.current.state.busySessionCount).toBe(1);

    // Confirm it isn't just a timing fluke: still nothing after a rerender
    // with the same busy count.
    rerender({ busy: 1 });
    await act(async () => {
      await result.current.installAndRelaunch();
    });
    expect(update.install).not.toHaveBeenCalled();
  });

  it("installs and relaunches once every session is idle", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);

    const { result } = renderHook(({ busy }: { busy: number }) => useAutoUpdater(busy), {
      initialProps: { busy: 0 },
    });

    await bootAndCheck();
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.ready).toBe(true);

    await act(async () => {
      await result.current.installAndRelaunch();
    });

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("a busy→idle transition unblocks a previously-deferred install", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);

    const { result, rerender } = renderHook(({ busy }: { busy: number }) => useAutoUpdater(busy), {
      initialProps: { busy: 2 },
    });

    await bootAndCheck();
    await act(async () => {
      await result.current.download();
    });

    await act(async () => {
      await result.current.installAndRelaunch();
    });
    expect(update.install).not.toHaveBeenCalled();

    // All agents finish — busy count drops to zero.
    rerender({ busy: 0 });
    await act(async () => {
      await result.current.installAndRelaunch();
    });

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("'Relaunch now' (force) installs immediately even while busy", async () => {
    const update = fakeUpdate();
    mockCheck.mockResolvedValue(update);

    const { result } = renderHook(({ busy }: { busy: number }) => useAutoUpdater(busy), {
      initialProps: { busy: 3 },
    });

    await bootAndCheck();
    await act(async () => {
      await result.current.download();
    });

    await act(async () => {
      await result.current.installAndRelaunch(undefined, { force: true });
    });

    expect(update.install).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("defaults busySessionCount to 0 when the caller passes none", async () => {
    mockCheck.mockResolvedValue(null);
    const { result } = renderHook(() => useAutoUpdater());
    await bootAndCheck();
    expect(result.current.state.busySessionCount).toBe(0);
  });

  it("ignores the e2e test override outside the e2e build", async () => {
    const update = fakeUpdate("1.2.3");
    mockCheck.mockResolvedValue(update);
    window.__HERMES_TEST_UPDATE__ = { forcedUpdate: { version: "99.0.0" }, installCalls: 0, relaunchCalls: 0 };
    try {
      const { result } = renderHook(() => useAutoUpdater(0));
      await bootAndCheck();
      // The real update source was asked, not the forced one.
      expect(mockCheck).toHaveBeenCalled();
      expect(result.current.state.version).toBe("1.2.3");

      await act(async () => {
        await result.current.download();
      });
      await act(async () => {
        await result.current.installAndRelaunch();
      });
      // The real relaunch ran; the override's counters were never touched.
      expect(update.install).toHaveBeenCalledTimes(1);
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
      expect(window.__HERMES_TEST_UPDATE__?.relaunchCalls).toBe(0);
    } finally {
      delete window.__HERMES_TEST_UPDATE__;
    }
  });
});
