// @vitest-environment jsdom
/**
 * I18nProvider / useI18n — the React binding over the i18n registry.
 *
 *   - Consumers render translated copy and RE-RENDER when setLanguage
 *     changes the active pack (useSyncExternalStore subscription).
 *   - The English fallback shows through for keys a pack doesn't carry.
 *   - useI18n throws a descriptive error outside the provider.
 *
 * The registry is a module-level singleton shared across this file, so
 * tests restore the default language and dispose their packs on exit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

import { I18nProvider, useI18n } from "../i18n/I18nProvider";
import {
  getCurrentLanguage,
  registerLanguagePack,
  setLanguage,
} from "../i18n/registry";

function CloseLabel() {
  const { t } = useI18n();
  return <p data-testid="close-label">{t("common.close")}</p>;
}

describe("I18nProvider", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    // Restore the default language so registry state never leaks between tests.
    await setLanguage("en");
  });

  it("re-renders consumers with translated text when the language changes", async () => {
    const disposable = registerLanguagePack({
      locale: "xxprov",
      label: "Provider Test",
      messages: { "common.close": "XX-zavřít" },
    });
    try {
      render(
        <I18nProvider>
          <CloseLabel />
        </I18nProvider>,
      );
      // Default language: English base pack.
      expect(screen.getByTestId("close-label")).toHaveTextContent("Close");

      await act(async () => {
        await setLanguage("xxprov");
      });
      expect(screen.getByTestId("close-label")).toHaveTextContent("XX-zavřít");
      expect(getCurrentLanguage()).toBe("xxprov");

      await act(async () => {
        await setLanguage("en");
      });
      expect(screen.getByTestId("close-label")).toHaveTextContent("Close");
    } finally {
      disposable.dispose();
    }
  });

  it("falls back to English for keys the active pack doesn't carry", async () => {
    function Mixed() {
      const { t } = useI18n();
      return (
        <p data-testid="mixed">
          {t("common.close")}|{t("common.cancel")}
        </p>
      );
    }
    const disposable = registerLanguagePack({
      locale: "xxpart",
      label: "Partial",
      messages: { "common.close": "XX-close" },
    });
    try {
      render(
        <I18nProvider>
          <Mixed />
        </I18nProvider>,
      );
      await act(async () => {
        await setLanguage("xxpart");
      });
      // "common.close" comes from the pack; "common.cancel" falls back to English.
      expect(screen.getByTestId("mixed")).toHaveTextContent("XX-close|Cancel");
    } finally {
      disposable.dispose();
    }
  });

  it("useI18n throws a descriptive error outside the provider", () => {
    // React logs the render error noisily — mute it for this assertion.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<CloseLabel />)).toThrow(
        "useI18n must be used inside I18nProvider",
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
