// @vitest-environment jsdom
/**
 * F04 (private by default) — update polling never runs in an e2e/CI build.
 *
 * `useAutoUpdater` reads `VITE_HERMES_E2E` once at module load (the same
 * build-time flag `analytics.ts` and `main.tsx` use), so each scenario
 * stubs the env var and re-imports the hook fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mockCheck = vi.fn(() => Promise.resolve(null));

vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {},
}));
vi.mock("../api/updater", () => ({
  checkForUpdate: (...args: unknown[]) => mockCheck(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mockCheck.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("useAutoUpdater under VITE_HERMES_E2E=1", () => {
  it("never calls check(), on launch or after the periodic interval", async () => {
    vi.stubEnv("VITE_HERMES_E2E", "1");
    const { useAutoUpdater } = await import("../hooks/useAutoUpdater");

    renderHook(() => useAutoUpdater());

    // Past both the launch delay (5s) and a full periodic interval (4h).
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);

    expect(mockCheck).not.toHaveBeenCalled();
  });
});

describe("useAutoUpdater outside an e2e build (regression guard)", () => {
  it("calls check() after the launch delay", async () => {
    vi.stubEnv("VITE_HERMES_E2E", undefined);
    const { useAutoUpdater } = await import("../hooks/useAutoUpdater");

    renderHook(() => useAutoUpdater());

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});
