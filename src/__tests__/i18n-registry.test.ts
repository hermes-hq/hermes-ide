// @vitest-environment jsdom
/**
 * i18n registry — the core translation store.
 *
 * Covers:
 *   - registerLanguagePack / lookup via getI18nSnapshot
 *   - interpolation ({placeholder} substitution and missing-value behavior)
 *   - the fallback chain: active pack → English base → raw key
 *   - setLanguage validation (unregistered locales are rejected)
 *   - dispose ownership (a stale dispose must not remove a pack another
 *     plugin re-registered for the same locale; disposing the active pack
 *     resets the language to English)
 *   - initI18n (stored-locale restore + the concurrent-setLanguage guard)
 *
 * The registry is module-level singleton state, so every test imports a
 * FRESH copy of the module (vi.resetModules) to stay isolated.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

type Registry = typeof import("../i18n/registry");

async function freshRegistry(): Promise<{
  registry: Registry;
  getSetting: ReturnType<typeof vi.fn>;
  setSetting: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  const settings = await import("../api/settings");
  const registry = await import("../i18n/registry");
  return {
    registry,
    getSetting: vi.mocked(settings.getSetting),
    setSetting: vi.mocked(settings.setSetting),
  };
}

const TEST_PACK = {
  locale: "xx",
  label: "Testish",
  messages: {
    "common.close": "XX-close",
    "session.step": "XX step {current} of {total}",
  },
};

beforeEach(() => {
  localStorage.clear();
});

describe("registerLanguagePack / lookup", () => {
  it("registers a pack and lists it in the snapshot until disposed", async () => {
    const { registry } = await freshRegistry();
    expect(registry.getI18nSnapshot().languages.map((p) => p.locale)).toEqual(["en"]);

    const disposable = registry.registerLanguagePack(TEST_PACK);
    expect(registry.getI18nSnapshot().languages.map((p) => p.locale)).toContain("xx");

    disposable.dispose();
    expect(registry.getI18nSnapshot().languages.map((p) => p.locale)).not.toContain("xx");
  });

  it("returns a referentially stable snapshot between mutations", async () => {
    const { registry } = await freshRegistry();
    // useSyncExternalStore requires this: no new object unless something changed.
    const before = registry.getI18nSnapshot();
    expect(registry.getI18nSnapshot()).toBe(before);

    const disposable = registry.registerLanguagePack(TEST_PACK);
    const after = registry.getI18nSnapshot();
    expect(after).not.toBe(before);
    expect(registry.getI18nSnapshot()).toBe(after);
    disposable.dispose();
  });

  it("rejects a pack with a blank locale", async () => {
    const { registry } = await freshRegistry();
    expect(() =>
      registry.registerLanguagePack({ locale: "   ", label: "Bad", messages: {} }),
    ).toThrow(/locale is required/i);
  });

  it("falls back to the locale as the label when the label is blank", async () => {
    const { registry } = await freshRegistry();
    const disposable = registry.registerLanguagePack({
      locale: "xx",
      label: "   ",
      messages: {},
    });
    const pack = registry.getI18nSnapshot().languages.find((p) => p.locale === "xx");
    expect(pack?.label).toBe("xx");
    disposable.dispose();
  });
});

describe("translate — interpolation", () => {
  it("substitutes {placeholder} tokens from the values map", async () => {
    const { registry } = await freshRegistry();
    expect(registry.translate("session.step", { current: 2, total: 4 })).toBe("Step 2 of 4");
  });

  it("coerces numeric values to strings", async () => {
    const { registry } = await freshRegistry();
    expect(registry.translate("status.tokens", { count: 1234 })).toBe("1234 tokens");
  });

  it("keeps the raw {placeholder} when a value is missing from the map", async () => {
    const { registry } = await freshRegistry();
    expect(registry.translate("session.step", { current: 2 })).toBe("Step 2 of {total}");
  });

  it("keeps all placeholders when no values map is given", async () => {
    const { registry } = await freshRegistry();
    expect(registry.translate("session.step")).toBe("Step {current} of {total}");
  });
});

describe("translate — fallback chain", () => {
  it("prefers the active pack, then English, then the raw key", async () => {
    const { registry } = await freshRegistry();
    const disposable = registry.registerLanguagePack(TEST_PACK);
    await registry.setLanguage("xx");

    // 1. Present in the active pack → translated.
    expect(registry.translate("common.close")).toBe("XX-close");
    // 2. Missing from the active pack, present in English → English fallback.
    expect(registry.translate("common.cancel")).toBe("Cancel");
    // 3. Missing everywhere → the raw key.
    expect(registry.translate("no.such.key.exists")).toBe("no.such.key.exists");

    disposable.dispose();
  });

  it("interpolates using the active pack's template", async () => {
    const { registry } = await freshRegistry();
    const disposable = registry.registerLanguagePack(TEST_PACK);
    await registry.setLanguage("xx");
    expect(registry.translate("session.step", { current: 1, total: 9 })).toBe("XX step 1 of 9");
    disposable.dispose();
  });

  it("warns once per missing key in dev, then stays quiet", async () => {
    const { registry } = await freshRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      registry.translate("missing.once.key");
      registry.translate("missing.once.key");
      const calls = warn.mock.calls.filter((args) =>
        String(args[0]).includes("missing.once.key"),
      );
      expect(calls).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("setLanguage", () => {
  it("switches the current language and persists it (settings + localStorage)", async () => {
    const { registry, setSetting } = await freshRegistry();
    const disposable = registry.registerLanguagePack(TEST_PACK);

    await registry.setLanguage("xx");
    expect(registry.getCurrentLanguage()).toBe("xx");
    expect(localStorage.getItem("hermes.ui_language")).toBe("xx");
    expect(setSetting).toHaveBeenCalledWith(registry.UI_LANGUAGE_SETTING, "xx");

    disposable.dispose();
  });

  it("rejects an unregistered locale and keeps the current language", async () => {
    const { registry } = await freshRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await registry.setLanguage("zz");
      expect(registry.getCurrentLanguage()).toBe("en");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("zz"));
      expect(localStorage.getItem("hermes.ui_language")).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it("normalizes locale casing (xx-yy matches a registered xx-YY pack)", async () => {
    const { registry } = await freshRegistry();
    const disposable = registry.registerLanguagePack({
      locale: "xx-YY",
      label: "Regional",
      messages: { "common.close": "Regional close" },
    });

    await registry.setLanguage("XX-yy");
    expect(registry.getCurrentLanguage()).toBe("xx-YY");
    expect(registry.translate("common.close")).toBe("Regional close");

    disposable.dispose();
  });
});

describe("dispose ownership", () => {
  it("a stale dispose does NOT remove a pack re-registered by another plugin", async () => {
    const { registry } = await freshRegistry();
    const pluginA = registry.registerLanguagePack({
      locale: "xx",
      label: "Pack A",
      messages: { "common.close": "A-close" },
    });
    const pluginB = registry.registerLanguagePack({
      locale: "xx",
      label: "Pack B",
      messages: { "common.close": "B-close" },
    });

    // A unloads first: its disposable is stale (the live entry is B's pack)
    // and must leave the locale alone.
    pluginA.dispose();
    const live = registry.getI18nSnapshot().languages.find((p) => p.locale === "xx");
    expect(live?.label).toBe("Pack B");

    // B unloads: its `previous` was A's pack, so A is restored rather than
    // the locale vanishing from under other consumers.
    pluginB.dispose();
    const restored = registry.getI18nSnapshot().languages.find((p) => p.locale === "xx");
    expect(restored?.label).toBe("Pack A");

    // A's dispose is live again now — removes the locale entirely.
    pluginA.dispose();
    expect(registry.getI18nSnapshot().languages.some((p) => p.locale === "xx")).toBe(false);
  });

  it("disposing the ACTIVE pack resets the language to English and persists it", async () => {
    const { registry, setSetting } = await freshRegistry();
    const disposable = registry.registerLanguagePack(TEST_PACK);
    await registry.setLanguage("xx");
    expect(registry.getCurrentLanguage()).toBe("xx");

    disposable.dispose();
    expect(registry.getCurrentLanguage()).toBe("en");
    expect(setSetting).toHaveBeenCalledWith(registry.UI_LANGUAGE_SETTING, "en");
    // Translation immediately falls back to English copy.
    expect(registry.translate("common.close")).toBe("Close");
  });
});

describe("initI18n", () => {
  it("restores the stored language from settings", async () => {
    const { registry, getSetting } = await freshRegistry();
    getSetting.mockResolvedValue("xx");
    const disposable = registry.registerLanguagePack(TEST_PACK);

    await registry.initI18n();
    expect(registry.getCurrentLanguage()).toBe("xx");
    expect(registry.translate("common.close")).toBe("XX-close");

    disposable.dispose();
  });

  it("keeps a stored locale as a pending preference when no pack is registered yet", async () => {
    const { registry, getSetting } = await freshRegistry();
    getSetting.mockResolvedValue("xx");

    await registry.initI18n();
    // Applied even without a pack — translate() falls back to English.
    expect(registry.getCurrentLanguage()).toBe("xx");
    expect(registry.translate("common.close")).toBe("Close");

    // When the pack arrives (plugin loads later), translations activate.
    const disposable = registry.registerLanguagePack(TEST_PACK);
    expect(registry.translate("common.close")).toBe("XX-close");
    disposable.dispose();
  });

  it("does not clobber a setLanguage that lands while the settings read is in flight", async () => {
    const { registry, getSetting } = await freshRegistry();
    let resolveStored: (value: string) => void = () => {};
    getSetting.mockImplementation(
      () => new Promise<string>((resolve) => { resolveStored = resolve; }),
    );
    const keepXx = registry.registerLanguagePack(TEST_PACK);
    const keepYy = registry.registerLanguagePack({
      locale: "yy",
      label: "Y",
      messages: { "common.close": "YY-close" },
    });

    const initPromise = registry.initI18n();
    // The user switches language before the async settings read resolves.
    await registry.setLanguage("yy");
    resolveStored("xx");
    await initPromise;

    expect(registry.getCurrentLanguage()).toBe("yy");
    expect(registry.translate("common.close")).toBe("YY-close");

    keepXx.dispose();
    keepYy.dispose();
  });

  it("is a no-op on the second call (initialized guard)", async () => {
    const { registry, getSetting } = await freshRegistry();
    getSetting.mockResolvedValue("xx");
    const disposable = registry.registerLanguagePack(TEST_PACK);

    await registry.initI18n();
    expect(registry.getCurrentLanguage()).toBe("xx");

    getSetting.mockResolvedValue("en");
    await registry.initI18n();
    expect(registry.getCurrentLanguage()).toBe("xx");

    disposable.dispose();
  });
});
