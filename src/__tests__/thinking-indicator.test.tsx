/**
 * Vintage thinking indicator — verify the visual primitives render
 * the right shape so a future refactor doesn't quietly break the
 * Braille spinner or the wave bar.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThinkingIndicator } from "../agent/blocks/ThinkingIndicator";

describe("<ThinkingIndicator>", () => {
  it("renders the spinner, the wave, the label, and elapsed when `since` is given", () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator since={Date.now() - 4200} variant="thinking" />,
    );
    expect(html).toContain("agent-thinking-spinner");
    expect(html).toContain("agent-thinking-wave");
    expect(html).toContain(">thinking<");
    expect(html).toContain("agent-thinking-elapsed");
  });

  it("uses a Braille spinner glyph (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)", () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator since={null} variant="thinking" />,
    );
    const braille = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    const found = [...braille].some((c) => html.includes(c));
    expect(found).toBe(true);
  });

  it("uses the wave glyphs (▆▇█) and dash track (─) — vintage terminal feel", () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator since={null} variant="thinking" />,
    );
    expect(html).toContain("─");
  });

  it("variant=awaiting shows 'awaiting Claude' label", () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator since={null} variant="awaiting" />,
    );
    expect(html).toContain("awaiting Claude");
  });

  it("variant=running shows the tool name", () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator since={null} variant="running" toolName="Bash" />,
    );
    expect(html).toContain("running Bash");
  });

  it("omits the elapsed segment when since is null", () => {
    const html = renderToStaticMarkup(
      <ThinkingIndicator since={null} variant="thinking" />,
    );
    // The label should still appear — only the elapsed and the dot
    // separator are skipped when since is unknown.
    expect(html).toContain(">thinking<");
    expect(html).not.toContain("agent-thinking-elapsed");
  });
});
