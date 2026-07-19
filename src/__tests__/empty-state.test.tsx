/**
 * EmptyState — workshop-atelier hero.  Pins the v1.1 redesign:
 *
 *   - The legacy `terminal & IDE` framing stays banished.
 *   - The new tagline ("instrument panel for working with code &
 *     agents") is rendered.
 *   - The masthead, contents-page index ("I.", "II."), and the
 *     three primary tiles (New session / Command palette / Context
 *     panel) all show up — these are the contract this surface
 *     delivers.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { EmptyState } from "../components/EmptyState";
import { I18nProvider } from "../i18n/I18nProvider";
import type { SessionHistoryEntry } from "../state/SessionContext";

// Mock platform helpers so the EmptyState renders without browser/OS sniffing.
vi.mock("../utils/platform", () => ({
  fmt: (s: string) => s.replace("{mod}", "Cmd+"),
}));

// EmptyState requires the palette/context callbacks and reads its copy
// through useI18n() — wrap every render in the provider.
function renderEmpty(recentSessions: SessionHistoryEntry[]): string {
  return renderToString(
    <I18nProvider>
      <EmptyState
        recentSessions={recentSessions}
        onNew={() => {}}
        onOpenPalette={() => {}}
        onToggleContext={() => {}}
        onRestore={() => {}}
      />
    </I18nProvider>,
  );
}

describe("EmptyState — workshop-atelier hero (v1.1 redesign)", () => {
  it("renders the new tagline (instrument panel for working with code & agents)", () => {
    const html = renderEmpty([]);
    expect(html).toContain("instrument panel");
    expect(html).toMatch(/code\s*(&amp;|&)\s*agents/);
  });

  it("does not render the legacy 'AI-native terminal & IDE' tagline", () => {
    const html = renderEmpty([]);
    expect(html).not.toContain("AI-native terminal");
    expect(html).not.toContain("AI-native development environment");
  });

  it("renders the contents-page index labels (I., II.)", () => {
    const html = renderEmpty([
      {
        id: "s1",
        label: "old session",
        color: "#000",
        working_directory: "/Users/me/project",
        closed_at: "2026-01-01T00:00:00Z",
      } as never,
    ]);
    // Index numerals — "I." for the actions, "II." for the logbook.
    expect(html).toContain(">I.<");
    expect(html).toContain(">II.<");
  });

  it("renders the three primary tiles", () => {
    const html = renderEmpty([]);
    expect(html).toContain("New session");
    expect(html).toContain("Command palette");
    expect(html).toContain("Context panel");
  });

  it("renders the marginalia logbook numbers when recent sessions exist", () => {
    const html = renderEmpty([
      {
        id: "s1",
        label: "ira-site",
        color: "#a78bfa",
        working_directory: "/Users/me/projects/ira-site",
        closed_at: "2026-01-01T00:00:00Z",
      } as never,
    ]);
    // Marginalia numeral (№ 01 with the SERIF italic styling).
    expect(html).toMatch(/№\s*01/);
    // Session label is rendered.
    expect(html).toContain("ira-site");
  });
});
