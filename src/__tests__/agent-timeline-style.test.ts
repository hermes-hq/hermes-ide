// @vitest-environment jsdom
/**
 * `applyAgentTimelineStyle` — toggles the `data-agent-timeline-style`
 * attribute on <html> so CSS overrides under
 * `html[data-agent-timeline-style="classic"]` activate the pre-1.1
 * logbook look.  Pins:
 *   - "modern" / undefined / unknown values clear the attribute
 *   - "classic" sets the attribute
 *   - The CSS override file actually scopes to that selector (so the
 *     toggle isn't dead UI).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAgentTimelineStyle } from "../utils/themeManager";

describe("applyAgentTimelineStyle", () => {
  beforeEach(() => {
    delete document.documentElement.dataset.agentTimelineStyle;
  });

  it('"classic" sets data-agent-timeline-style="classic" on <html>', () => {
    applyAgentTimelineStyle("classic");
    expect(document.documentElement.dataset.agentTimelineStyle).toBe("classic");
  });

  it('"modern" clears the attribute', () => {
    applyAgentTimelineStyle("classic");
    applyAgentTimelineStyle("modern");
    expect(document.documentElement.dataset.agentTimelineStyle).toBeUndefined();
  });

  it("undefined clears the attribute (default = modern)", () => {
    applyAgentTimelineStyle("classic");
    applyAgentTimelineStyle(undefined);
    expect(document.documentElement.dataset.agentTimelineStyle).toBeUndefined();
  });

  it("unknown values fall through to modern (no surprises)", () => {
    applyAgentTimelineStyle("classic");
    applyAgentTimelineStyle("retro");
    expect(document.documentElement.dataset.agentTimelineStyle).toBeUndefined();
  });
});

describe("classic-mode CSS overrides exist", () => {
  it("AgentSessionView.css has rules under [data-agent-timeline-style='classic']", () => {
    const css = readFileSync(
      resolve(__dirname, "../styles/components/agent/AgentSessionView.css"),
      "utf8",
    );
    // Must touch the body font (mono restoration) — single most
    // important visual override.
    expect(css).toMatch(
      /html\[data-agent-timeline-style=["']classic["']\][\s\S]*?\.agent-message-body[\s\S]*?font-family:\s*var\(--font-mono\)/,
    );
    // Must restore the brass left-bar treatment on user messages.
    expect(css).toMatch(
      /html\[data-agent-timeline-style=["']classic["']\][\s\S]*?\[data-role=["']user["']\][\s\S]*?border-left:\s*2px solid var\(--brass/,
    );
    // Must add the hairline rule between turns.
    expect(css).toMatch(
      /html\[data-agent-timeline-style=["']classic["']\][\s\S]*?\.agent-message \+ \.agent-message\[data-role=["']user["']\][\s\S]*?border-top:\s*1px solid var\(--rule\)/,
    );
  });
});
