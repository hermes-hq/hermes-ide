// @vitest-environment jsdom
/**
 * N07 — the top-bar badge that proves a flag gates a visible surface.
 *
 *   - Hidden when the flag is off (stable, no override).
 *   - Shown when the flag is on, with a translated tooltip that names the
 *     flag, in English and in another language pack.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const h = vi.hoisted(() => ({
  getVersion: vi.fn(() => Promise.resolve("1.4.0")),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: h.getVersion }));
vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({})),
}));

import { I18nProvider } from "../i18n/I18nProvider";
import { registerLanguagePack, setLanguage } from "../i18n/registry";
import { languagePacks } from "../i18n/packs";
import { FeatureFlagDummyBanner } from "../components/FeatureFlagDummyBanner";
import { initFeatureFlags, __resetFeatureFlagsForTest, FEATURE_FLAG_OVERRIDES_KEY } from "../featureFlags";

function renderBadge() {
  return render(
    <I18nProvider>
      <FeatureFlagDummyBanner />
    </I18nProvider>,
  );
}

describe("N07 feature-flag badge", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetFeatureFlagsForTest();
  });
  afterEach(async () => {
    cleanup();
    __resetFeatureFlagsForTest();
    await act(async () => {
      await setLanguage("en");
    });
  });

  it("is not rendered when the flag is off on stable", async () => {
    await initFeatureFlags({});
    renderBadge();
    expect(screen.queryByText("FLAG")).toBeNull();
  });

  it("is rendered with a tooltip naming the flag when an override forces it on", async () => {
    await initFeatureFlags({ [FEATURE_FLAG_OVERRIDES_KEY]: JSON.stringify({ dummyProofSurface: true }) });
    renderBadge();
    expect(screen.getByText("FLAG")).toHaveAttribute("title", "Feature flag: dummyProofSurface");
  });

  it("translates the tooltip with the active language pack", async () => {
    const ja = languagePacks.find((p) => p.locale === "ja");
    if (!ja) throw new Error("ja pack missing");
    const registration = registerLanguagePack(ja);
    try {
      await act(async () => {
        await setLanguage("ja");
      });
      await initFeatureFlags({ update_channel: "beta" });
      renderBadge();
      expect(screen.getByText("FLAG")).toHaveAttribute("title", "機能フラグ: dummyProofSurface");
    } finally {
      registration.dispose();
    }
  });
});
