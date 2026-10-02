// @vitest-environment jsdom
/**
 * CHAOS-08 — a check the person asks for (Help > Check for Updates…, the
 * version chip) always ends in a result the app can show: "available",
 * "none" or "error" (offline, endpoint down, or no answer within 15 s), with
 * `checking` set meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const mockCheck = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));

vi.mock("@tauri-apps/plugin-updater", () => ({ Update: class {} }));
vi.mock("../api/updater", () => ({ checkForUpdate: () => mockCheck() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { CHECK_TIMEOUT_MS, useAutoUpdater, withTimeout, type UpdateCheckResult } from "../hooks/useAutoUpdater";

beforeEach(() => {
  vi.useFakeTimers();
  mockCheck.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

async function check(hook: { current: ReturnType<typeof useAutoUpdater> }): Promise<UpdateCheckResult> {
  let result: UpdateCheckResult | undefined;
  await act(async () => {
    result = await hook.current.manualCheck();
  });
  return result!;
}

describe("manualCheck", () => {
  it("says none when Hermes is up to date", async () => {
    mockCheck.mockResolvedValue(null);
    const { result } = renderHook(() => useAutoUpdater());
    expect(await check(result)).toBe("none");
    expect(result.current.state.checking).toBe(false);
    expect(result.current.state.available).toBe(false);
  });

  it("says available when an update is found", async () => {
    mockCheck.mockResolvedValue({ version: "9.9.9", body: "notes" });
    const { result } = renderHook(() => useAutoUpdater());
    expect(await check(result)).toBe("available");
    expect(result.current.state.available).toBe(true);
    expect(result.current.state.version).toBe("9.9.9");
  });

  it("says error when the check fails (offline, endpoint down)", async () => {
    mockCheck.mockRejectedValue(new Error("error sending request: connection refused"));
    const { result } = renderHook(() => useAutoUpdater());
    expect(await check(result)).toBe("error");
    expect(result.current.state.checking).toBe(false);
  });

  it("is checking meanwhile, gives up after 15 s without an answer, and joins a second request", async () => {
    mockCheck.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAutoUpdater());
    let first: Promise<UpdateCheckResult> | undefined;
    let second: Promise<UpdateCheckResult> | undefined;
    act(() => {
      first = result.current.manualCheck();
    });
    expect(result.current.state.checking).toBe(true);
    act(() => {
      second = result.current.manualCheck();
    });
    expect(mockCheck).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    });
    expect(result.current.state.checking).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(await first).toBe("error");
    expect(await second).toBe("error");
    expect(result.current.state.checking).toBe(false);
  });
});

describe("withTimeout", () => {
  it("passes the answer through and clears its timer", async () => {
    await expect(withTimeout(Promise.resolve(3), 10)).resolves.toBe(3);
    await expect(withTimeout(Promise.reject(new Error("x")), 10)).rejects.toThrow("x");
    expect(vi.getTimerCount()).toBe(0);
  });
});
