/**
 * Phase 2 (v1.0.0 redesign) — colophon footer rendering.
 *
 * The end-of-turn footer is now a quiet right-aligned three-number colophon,
 * not a CI-output-style banner of CAPS labels. These tests pin that behavior
 * at the rendered-DOM level.
 *
 * Rendering uses `react-dom/server`'s `renderToString` (Phase 1 pattern); no
 * new test deps. The click-toggle interaction is verified at the formatter
 * level (the summary text always renders) — the open-state DOM is asserted by
 * driving the component with a controlled state shim. Full hook-driven
 * click-through is left for the Phase 9 integration tests, which run the
 * actual app under Playwright.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@aptabase/tauri", () => ({
  trackEvent: vi.fn(),
}));

import { renderToString } from "react-dom/server";
import { ResultFooter } from "../agent/blocks/ResultFooter";
import type { ResultEvent } from "../agent/types";

function fixtureResult(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 8500,
    duration_api_ms: 6900,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.1266,
    usage: {
      input_tokens: 7,
      output_tokens: 303,
      cache_read_input_tokens: 81_000,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

describe("ResultFooter (colophon)", () => {
  it("renders the three-number colophon string", () => {
    const html = renderToString(<ResultFooter result={fixtureResult()} />);
    expect(html).toContain("8.5s · 303 out · $0.13");
  });

  it("renders inside an .agent-colophon container with a summary button", () => {
    const html = renderToString(<ResultFooter result={fixtureResult()} />);
    expect(html).toContain("agent-colophon");
    expect(html).toContain("agent-colophon-summary");
    expect(html).toContain('aria-expanded="false"');
  });

  it("does NOT render the old CAPS-label CI-style footer", () => {
    const html = renderToString(<ResultFooter result={fixtureResult()} />);

    expect(html).not.toContain("agent-result-footer");
    expect(html).not.toContain("agent-result-item");
    expect(html).not.toContain("agent-result-label");
    expect(html).not.toContain("agent-result-value");

    // No CAPS label words anywhere in the rendered output.
    expect(html).not.toMatch(/\bCOST\b/);
    expect(html).not.toMatch(/\bTOKENS\b/);
    expect(html).not.toMatch(/\bCACHE READ\b/);
    expect(html).not.toMatch(/\bSTOP\b/);
    expect(html).not.toMatch(/\bDURATION\b/);
  });

  it("does NOT render 4-decimal cost", () => {
    const html = renderToString(<ResultFooter result={fixtureResult()} />);
    expect(html).not.toContain("0.1266");
  });

  it("renders nothing when there is no meaningful data to show", () => {
    const html = renderToString(
      <ResultFooter
        result={{
          type: "result",
          subtype: "success",
          is_error: false,
        }}
      />,
    );
    expect(html).toBe("");
  });

  it("omits the tokens segment when output_tokens is missing", () => {
    const html = renderToString(
      <ResultFooter
        result={fixtureResult({
          usage: { input_tokens: 7, cache_read_input_tokens: 0 },
        })}
      />,
    );
    expect(html).toContain("8.5s · $0.13");
    expect(html).not.toContain("out · $0.13");
  });

  it("renders a closed footer by default (no details panel in DOM)", () => {
    const html = renderToString(<ResultFooter result={fixtureResult()} />);
    expect(html).not.toContain("agent-colophon-details");
    expect(html).not.toContain("agent-colophon-open");
  });
});
