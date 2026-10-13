/**
 * F04 (analytics on by default, opt-out respected) — analytics runs unless
 * the user stored `telemetry_enabled="false"`, and the backend decides
 * whether it may run at all (it refuses in test runs). Turning it on or off
 * takes effect immediately, without a restart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSetting = vi.fn();
const mockSetSetting = vi.fn((..._args: unknown[]) => Promise.resolve());
const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("../api/settings", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
  setSetting: (...args: unknown[]) => mockSetSetting(...args),
}));

const TRACK = "plugin:aptabase|track_event";

/** Backend stand-in: `enable_analytics` answers `backendAllows`, tracking
 *  succeeds unless `trackFails`. */
function backend({ backendAllows = true, trackFails = false } = {}) {
  mockInvoke.mockImplementation((cmd: unknown) => {
    if (cmd === "enable_analytics") return Promise.resolve(backendAllows);
    if (cmd === TRACK) return trackFails ? Promise.reject(new Error("plugin aptabase not found")) : Promise.resolve();
    return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
  });
}

const sent = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === TRACK).map(([, args]) => args);
const enableCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "enable_analytics").length;

async function freshModule() {
  vi.resetModules();
  return import("../utils/analytics");
}

beforeEach(() => {
  mockGetSetting.mockReset();
  mockSetSetting.mockReset();
  mockSetSetting.mockResolvedValue(undefined);
  mockInvoke.mockReset();
  backend();
});

describe("at startup", () => {
  it.each([
    ["an empty value", ""],
    ["a missing key", null],
  ])("is on for a fresh profile (%s) once the backend confirms", async (_label, stored) => {
    mockGetSetting.mockResolvedValue(stored);
    const analytics = await freshModule();
    await analytics.initAnalytics();
    analytics.trackAppStarted();

    expect(enableCalls()).toBe(1);
    expect(sent()).toEqual([{ name: "app_started", props: null }]);
  });

  it('stays off when the user turned it off ("false") and never asks the backend', async () => {
    mockGetSetting.mockResolvedValue("false");
    const analytics = await freshModule();
    await analytics.initAnalytics();
    analytics.trackAppStarted();

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('sends events when the stored choice is "true" once the backend confirms', async () => {
    mockGetSetting.mockResolvedValue("true");
    const analytics = await freshModule();
    await analytics.initAnalytics();
    analytics.trackAppStarted();
    analytics.trackSessionCreated({ has_ai_provider: false });

    expect(enableCalls()).toBe(1);
    expect(sent()).toEqual([
      { name: "app_started", props: null },
      { name: "session_created", props: { has_ai_provider: 0 } },
    ]);
  });

  it("stays off when the backend refuses (test runs), even if the profile opted in", async () => {
    mockGetSetting.mockResolvedValue("true");
    backend({ backendAllows: false });
    const analytics = await freshModule();
    await analytics.initAnalytics();
    analytics.trackAppStarted();

    expect(sent()).toEqual([]);
  });

  it("stays off when the backend call fails", async () => {
    mockGetSetting.mockResolvedValue("true");
    mockInvoke.mockRejectedValue(new Error("command not found"));
    const analytics = await freshModule();
    await analytics.initAnalytics();
    analytics.trackAppStarted();

    expect(sent()).toEqual([]);
  });
});

describe("changing the choice while the app runs", () => {
  it("turning it back on persists the choice first, then starts analytics right away", async () => {
    mockGetSetting.mockResolvedValue("false");
    const order: string[] = [];
    mockSetSetting.mockImplementation(() => {
      order.push("persist");
      return Promise.resolve();
    });
    mockInvoke.mockImplementation((cmd: unknown) => {
      order.push(String(cmd));
      return Promise.resolve(cmd === "enable_analytics" ? true : undefined);
    });
    const analytics = await freshModule();
    await analytics.initAnalytics();

    await analytics.setAnalyticsEnabled(true);
    analytics.trackFeatureUsed("split-pane");

    expect(mockSetSetting).toHaveBeenCalledWith("telemetry_enabled", "true");
    expect(order).toEqual(["persist", "enable_analytics", TRACK]);
    expect(sent()).toEqual([{ name: "feature_used", props: { feature: "split-pane" } }]);
  });

  it.each([
    ["on by default (unset)", ""],
    ['stored "true"', "true"],
  ])("turning it off from %s persists \"false\", stops tracking at once and does not call the backend", async (_label, stored) => {
    mockGetSetting.mockResolvedValue(stored);
    const analytics = await freshModule();
    await analytics.initAnalytics();
    analytics.trackAppStarted();
    expect(sent()).toHaveLength(1); // tracking before the switch
    mockInvoke.mockClear();

    await analytics.setAnalyticsEnabled(false);
    analytics.trackAppStarted();

    expect(mockSetSetting).toHaveBeenCalledWith("telemetry_enabled", "false");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("a quick on-then-off ends up off even if the backend answers late", async () => {
    mockGetSetting.mockResolvedValue("false");
    let answer: (v: boolean) => void = () => {};
    mockInvoke.mockImplementation((cmd: unknown) =>
      cmd === "enable_analytics" ? new Promise<boolean>((r) => (answer = r)) : Promise.resolve(),
    );
    const analytics = await freshModule();
    await analytics.initAnalytics();

    const on = analytics.setAnalyticsEnabled(true);
    await vi.waitFor(() => expect(enableCalls()).toBe(1));
    await analytics.setAnalyticsEnabled(false);
    answer(true);
    await on;
    analytics.trackAppStarted();

    expect(sent()).toEqual([]);
  });

  it("a failed send is swallowed instead of surfacing as an unhandled rejection", async () => {
    mockGetSetting.mockResolvedValue("true");
    backend({ trackFails: true });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const analytics = await freshModule();
      await analytics.initAnalytics();
      analytics.trackAppStarted();
      await new Promise((r) => setTimeout(r, 10));
      expect(sent()).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
