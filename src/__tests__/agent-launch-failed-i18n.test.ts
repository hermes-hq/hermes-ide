// @vitest-environment jsdom
/**
 * F06 follow-up: the "agent was not found" warning follows the UI language
 * instead of always being English.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../api/settings", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

import { launchFailedMessage } from "../catalog/agentCatalog";
import { registerLanguagePack, setLanguage } from "../i18n/registry";
import { dePack } from "../i18n/packs/de";

describe("launchFailedMessage follows the UI language", () => {
  afterEach(async () => {
    await setLanguage("en");
  });

  it("is English by default", () => {
    expect(launchFailedMessage("copilot", "linux")).toBe(
      "GitHub Copilot CLI was not found. Install with: npm install -g @github/copilot",
    );
  });

  it("is German with the German pack active, keeping the agent name and install command", async () => {
    registerLanguagePack(dePack);
    await setLanguage("de");
    expect(launchFailedMessage("copilot", "linux")).toBe(
      "GitHub Copilot CLI wurde nicht gefunden. Installieren mit: npm install -g @github/copilot",
    );
    expect(launchFailedMessage("custom", "linux")).toBe(
      "Der Befehl des eigenen Agenten wurde nicht gefunden. Prüfe den Befehl in einer neuen Sitzung.",
    );
    expect(launchFailedMessage("mystery", "linux")).toBe("mystery wurde nicht gefunden.");
  });
});
