/**
 * F04 (private by default) — analytics never fires in an e2e/CI build.
 *
 * `VITE_HERMES_E2E=1` is the same build-time flag `e2e/app/build.mjs` sets
 * and `src/main.tsx` already uses to gate the test-only automation hooks.
 * `utils/analytics.ts` reads it once at module load, so each scenario
 * stubs the env var and re-imports the module fresh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTrackEvent = vi.fn();
const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn(() => Promise.resolve());

vi.mock("@aptabase/tauri", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

vi.mock("../api/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

beforeEach(() => {
  vi.resetModules();
  mockTrackEvent.mockClear();
  mockGetSetting.mockReset();
  mockSetSetting.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("analytics under VITE_HERMES_E2E=1", () => {
  it("never calls trackEvent even if the fixture profile opted in", async () => {
    vi.stubEnv("VITE_HERMES_E2E", "1");
    mockGetSetting.mockResolvedValue("true"); // an opted-in fixture profile

    const analytics = await import("../utils/analytics");
    await analytics.initAnalytics();
    analytics.trackAppStarted();
    analytics.trackSessionCreated({ execution_mode: "agent", has_ai_provider: true });
    analytics.trackFeatureUsed("split-pane");

    expect(mockTrackEvent).not.toHaveBeenCalled();
    // The e2e build shouldn't even need to consult the persisted setting.
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  it("ignores an explicit setAnalyticsEnabled(true) too", async () => {
    vi.stubEnv("VITE_HERMES_E2E", "1");

    const analytics = await import("../utils/analytics");
    analytics.setAnalyticsEnabled(true);
    analytics.trackAppStarted();

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("analytics outside an e2e build (regression guard)", () => {
  it("still sends events once opted in", async () => {
    vi.stubEnv("VITE_HERMES_E2E", undefined);
    mockGetSetting.mockResolvedValue("true");

    const analytics = await import("../utils/analytics");
    await analytics.initAnalytics();
    analytics.trackAppStarted();

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).toHaveBeenCalledWith("app_started", undefined);
  });

  it("stays off for a fresh profile with no persisted setting", async () => {
    vi.stubEnv("VITE_HERMES_E2E", undefined);
    mockGetSetting.mockResolvedValue(""); // getSetting's documented "missing key" value

    const analytics = await import("../utils/analytics");
    await analytics.initAnalytics();
    analytics.trackAppStarted();

    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});
