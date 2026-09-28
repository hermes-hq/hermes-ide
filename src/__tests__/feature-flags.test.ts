/**
 * N07 — feature flags.
 *
 * Covers:
 * - the registry cap (at most 6 flags alive at once)
 * - release-channel detection from the `update_channel` setting (which the
 *   updater's channel picker will write, N05) and from a -beta app version
 * - isFeatureFlagEnabled: off by default on stable, on for beta, and an
 *   override always wins
 * - overrides persist through the settings API and survive a reload
 * - malformed / unknown override data is ignored rather than crashing
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(() => Promise.resolve("1.4.0")),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));

import { FEATURE_FLAGS } from "../featureFlags/registry";
import { channelFromVersion, channelFromSetting, detectReleaseChannel } from "../featureFlags/channel";
import {
  initFeatureFlags,
  isFeatureFlagEnabled,
  getReleaseChannel,
  getFeatureFlagOverride,
  setFeatureFlagOverride,
  parseFeatureFlagOverrides,
  areFeatureFlagsReady,
  __resetFeatureFlagsForTest,
  FEATURE_FLAG_OVERRIDES_KEY,
  UPDATE_CHANNEL_KEY,
  type FeatureFlagId,
} from "../featureFlags";

const FLAG: FeatureFlagId = FEATURE_FLAGS[0].id;

describe("N07 feature-flag registry", () => {
  it("holds at most 6 flags — retire one before adding a 7th", () => {
    expect(FEATURE_FLAGS.length).toBeLessThanOrEqual(6);
  });

  it("has at least one flag (the proof surface) and every id is unique", () => {
    expect(FEATURE_FLAGS.length).toBeGreaterThan(0);
    const ids = FEATURE_FLAGS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every flag has a non-empty label and description", () => {
    for (const flag of FEATURE_FLAGS) {
      expect(flag.label.trim().length).toBeGreaterThan(0);
      expect(flag.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("N07 release channel from version string", () => {
  it.each([
    ["1.4.0", "stable"],
    ["1.4.0-beta", "beta"],
    ["1.4.0-beta.1", "beta"],
    ["1.4.0-beta.12", "beta"],
    ["1.4.0-rc.1", "stable"],
    ["1.4.0-dev", "stable"],
    ["2.0.0", "stable"],
  ] as const)("%s -> %s", (version, expected) => {
    expect(channelFromVersion(version)).toBe(expected);
  });
});

describe("N07 release channel from the update_channel setting", () => {
  it.each([
    ["beta", "beta"],
    [" Beta ", "beta"],
    ["BETA", "beta"],
    ["stable", "stable"],
    ["", "stable"],
    ["nightly", "stable"],
    [undefined, "stable"],
    [null, "stable"],
  ] as const)("%j -> %s", (value, expected) => {
    expect(channelFromSetting(value)).toBe(expected);
  });

  it("beta when either the setting or the version says beta", () => {
    expect(detectReleaseChannel("beta", "1.4.0")).toBe("beta");
    expect(detectReleaseChannel(undefined, "1.4.0-beta.1")).toBe("beta");
    expect(detectReleaseChannel("stable", "1.4.0-beta.1")).toBe("beta");
    expect(detectReleaseChannel("stable", "1.4.0")).toBe("stable");
    expect(detectReleaseChannel(undefined, "1.4.0")).toBe("stable");
  });
});

describe("N07 parseFeatureFlagOverrides", () => {
  it("returns {} for missing, empty, or malformed input", () => {
    expect(parseFeatureFlagOverrides(undefined)).toEqual({});
    expect(parseFeatureFlagOverrides(null)).toEqual({});
    expect(parseFeatureFlagOverrides("")).toEqual({});
    expect(parseFeatureFlagOverrides("{not json")).toEqual({});
    expect(parseFeatureFlagOverrides("[]")).toEqual({});
    expect(parseFeatureFlagOverrides("42")).toEqual({});
  });

  it("keeps only known flag ids with boolean values", () => {
    const raw = JSON.stringify({
      [FLAG]: true,
      unknownFlagId: true,
      alsoUnknown: "true",
      [`${FLAG}Extra`]: false,
    });
    expect(parseFeatureFlagOverrides(raw)).toEqual({ [FLAG]: true });
  });
});

describe("N07 isFeatureFlagEnabled", () => {
  beforeEach(() => {
    __resetFeatureFlagsForTest();
    h.invoke.mockReset();
    h.getVersion.mockReset();
  });
  afterEach(() => {
    __resetFeatureFlagsForTest();
  });

  it("before init, is not ready and defaults to stable (flag off)", () => {
    expect(areFeatureFlagsReady()).toBe(false);
    expect(getReleaseChannel()).toBe("stable");
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
  });

  it("is off on stable with no override", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    await initFeatureFlags({});
    expect(areFeatureFlagsReady()).toBe(true);
    expect(getReleaseChannel()).toBe("stable");
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
  });

  it("is on for the beta channel with no override", async () => {
    h.getVersion.mockResolvedValue("1.4.0-beta.3");
    await initFeatureFlags({});
    expect(getReleaseChannel()).toBe("beta");
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);
  });

  it("is on with no override when the person picked the beta update channel (same version number as stable)", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    await initFeatureFlags({ [UPDATE_CHANNEL_KEY]: "beta" });
    expect(getReleaseChannel()).toBe("beta");
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);
  });

  it("is off again when the person switches back to the stable update channel", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    await initFeatureFlags({ [UPDATE_CHANNEL_KEY]: "stable" });
    expect(getReleaseChannel()).toBe("stable");
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
  });

  it("an override forces a flag on for stable", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ [FLAG]: true }) });
    expect(getReleaseChannel()).toBe("stable");
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);
    expect(getFeatureFlagOverride(FLAG)).toBe(true);
  });

  it("an override forces a flag off for beta", async () => {
    h.getVersion.mockResolvedValue("1.4.0-beta.1");
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ [FLAG]: false }) });
    expect(getReleaseChannel()).toBe("beta");
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
  });

  it("setFeatureFlagOverride persists via setSetting and updates the cache immediately", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    h.invoke.mockResolvedValue(undefined);
    await initFeatureFlags({});
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);

    await setFeatureFlagOverride(FLAG, true);
    expect(h.invoke).toHaveBeenCalledWith("set_setting", {
      key: FEATURE_FLAG_OVERRIDES_KEY,
      value: JSON.stringify({ [FLAG]: true }),
    });
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);

    // Clearing the override (null) drops it back to the channel default.
    await setFeatureFlagOverride(FLAG, null);
    expect(h.invoke).toHaveBeenLastCalledWith("set_setting", {
      key: FEATURE_FLAG_OVERRIDES_KEY,
      value: "{}",
    });
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
  });

  it("a persisted override survives a fresh initFeatureFlags call (simulating restart)", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ [FLAG]: true }) });
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);

    // Simulate quitting and relaunching: state is wiped, then re-read from
    // the same persisted settings map.
    __resetFeatureFlagsForTest();
    expect(isFeatureFlagEnabled(FLAG)).toBe(false); // not ready yet -> safe default
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ [FLAG]: true }) });
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);
  });

  it("falls back to getSettings() when initFeatureFlags is called with no argument", async () => {
    h.getVersion.mockResolvedValue("1.4.0-beta");
    h.invoke.mockResolvedValueOnce({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ [FLAG]: false }) });
    await initFeatureFlags();
    expect(h.invoke).toHaveBeenCalledWith("get_settings");
    expect(getReleaseChannel()).toBe("beta");
    expect(isFeatureFlagEnabled(FLAG)).toBe(false); // overridden off despite beta
  });

  it("reads the update channel from getSettings() at startup", async () => {
    h.getVersion.mockResolvedValue("1.4.0");
    h.invoke.mockResolvedValueOnce({ [UPDATE_CHANNEL_KEY]: "beta" });
    await initFeatureFlags();
    expect(getReleaseChannel()).toBe("beta");
    expect(isFeatureFlagEnabled(FLAG)).toBe(true);
  });

  it("never rejects: a failing settings read falls back to the stable default", async () => {
    h.getVersion.mockRejectedValue(new Error("no runtime"));
    h.invoke.mockRejectedValueOnce(new Error("backend down"));
    await expect(initFeatureFlags()).resolves.toBeUndefined();
    expect(areFeatureFlagsReady()).toBe(true);
    expect(getReleaseChannel()).toBe("stable");
    expect(isFeatureFlagEnabled(FLAG)).toBe(false);
  });

  describe("when the backend is slow", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("resolves at the timeout with stable defaults and ignores the late answer", async () => {
      let answer!: (v: Record<string, string>) => void;
      h.getVersion.mockResolvedValue("1.4.0");
      h.invoke.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));

      let done = false;
      const init = initFeatureFlags(undefined, 2000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(1999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await init;
      expect(done).toBe(true);
      expect(areFeatureFlagsReady()).toBe(true);
      expect(isFeatureFlagEnabled(FLAG)).toBe(false);

      // The real answer arrives later: flags must not change mid-session.
      answer({ [UPDATE_CHANNEL_KEY]: "beta", [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ [FLAG]: true }) });
      await vi.advanceTimersByTimeAsync(10);
      expect(getReleaseChannel()).toBe("stable");
      expect(isFeatureFlagEnabled(FLAG)).toBe(false);
    });

    it("uses the real answer when it arrives before the timeout", async () => {
      h.getVersion.mockResolvedValue("1.4.0");
      h.invoke.mockReturnValueOnce(
        new Promise((resolve) => setTimeout(() => resolve({ [UPDATE_CHANNEL_KEY]: "beta" }), 500)),
      );
      const init = initFeatureFlags(undefined, 2000);
      await vi.advanceTimersByTimeAsync(500);
      await init;
      expect(getReleaseChannel()).toBe("beta");
      expect(isFeatureFlagEnabled(FLAG)).toBe(true);
    });
  });
});
