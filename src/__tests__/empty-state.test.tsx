/**
 * Phase 8 (v1.0.0 redesign) — EmptyState wording.
 *
 * Asserts that the empty state subtitle uses agent-leaning copy
 * ("AI-native development environment") instead of the legacy terminal-leaning
 * tagline ("AI-native terminal & IDE").
 */
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { EmptyState } from "../components/EmptyState";

// Mock platform helpers so the EmptyState renders without browser/OS sniffing.
vi.mock("../utils/platform", () => ({
  fmt: (s: string) => s.replace("{mod}", "Cmd+"),
}));

describe("EmptyState subtitle (Phase 8)", () => {
  it("renders 'AI-native development environment' as the subtitle", () => {
    const html = renderToString(
      <EmptyState recentSessions={[]} onNew={() => {}} onRestore={() => {}} />,
    );
    expect(html).toContain("AI-native development environment");
  });

  it("does not render the legacy 'AI-native terminal & IDE' tagline", () => {
    const html = renderToString(
      <EmptyState recentSessions={[]} onNew={() => {}} onRestore={() => {}} />,
    );
    expect(html).not.toContain("AI-native terminal");
    expect(html).not.toContain("AI-native terminal & IDE");
  });
});
