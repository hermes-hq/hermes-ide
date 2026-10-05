/**
 * Strings of views that load on demand (the Library): extendMessages adds
 * them to a registered pack, English as the fallback, and the Library keeps
 * the current language's strings there — also after a language is picked
 * later, or a language's own messages finish loading and replace the pack's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(async () => ""),
  setSetting: vi.fn(async () => {}),
}));

beforeEach(() => {
  vi.resetModules();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});

describe("extendMessages", () => {
  it("adds strings to a registered language, English as the fallback", async () => {
    const reg = await import("../i18n/registry");
    expect(reg.extendMessages("en", { "view.hello": "Hello {name}", "view.only": "Only English" })).toBe(true);
    reg.registerLanguagePack({ locale: "de", label: "German", messages: { "app.app": "App" } });
    await reg.setLanguage("de");
    expect(reg.extendMessages("de", { "view.hello": "Hallo {name}" })).toBe(true);
    expect(reg.translate("view.hello", { name: "Ada" })).toBe("Hallo Ada");
    expect(reg.translate("view.only")).toBe("Only English");
    expect(reg.extendMessages("xx", { a: "b" })).toBe(false);
  });
});

describe("the Library's strings", () => {
  it("follow the language, now and when it changes", async () => {
    const reg = await import("../i18n/registry");
    const { ensureLibraryMessages } = await import("../library/messages");
    const { libraryDe } = await import("../library/messages/de");
    const { libraryFr } = await import("../library/messages/fr");
    reg.registerLanguagePack({ locale: "de", label: "German", messages: { "app.app": "App" } });
    reg.registerLanguagePack({ locale: "fr", label: "French", messages: { "app.app": "Appli" } });
    await reg.setLanguage("de");
    await ensureLibraryMessages();
    expect(reg.translate("library.title")).toBe(libraryDe["library.title"]);
    await reg.setLanguage("fr");
    await vi.waitFor(() => expect(reg.translate("library.title")).toBe(libraryFr["library.title"]));
  });

  it("come back after a lazily loaded language replaces its pack's messages", async () => {
    const reg = await import("../i18n/registry");
    const { ensureLibraryMessages } = await import("../library/messages");
    const { libraryJa } = await import("../library/messages/ja");
    await ensureLibraryMessages();
    reg.registerLanguagePack({
      locale: "ja",
      label: "Japanese",
      load: async () => ({ locale: "ja", label: "Japanese", messages: { "app.app": "アプリ" } }),
    });
    await reg.setLanguage("ja");
    await vi.waitFor(() => expect(reg.translate("library.title")).toBe(libraryJa["library.title"]));
    expect(reg.translate("app.app")).toBe("アプリ");
  });
});
