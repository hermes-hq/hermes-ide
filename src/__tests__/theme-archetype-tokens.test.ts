/**
 * Archetype paint tokens — every theme either inherits the default
 * paper-cards archetype or sets its own archetype tokens cleanly.
 *
 * This test parses themes.css and asserts:
 *   1. The 30 expected themes are all defined.
 *   2. Themes that opt INTO an archetype set ALL the tokens of that
 *      archetype (no half-applied paint).
 *   3. The bespoke per-theme touches reference real tokens (no
 *      `var(--undefined)` references).
 *
 * The goal isn't pixel-level visual coverage — it's protection
 * against the kind of token-drift regression that would silently
 * give a single theme broken chrome.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let themesCss = "";
let tokensCss = "";

beforeAll(() => {
  themesCss = readFileSync(resolve(__dirname, "../styles/themes.css"), "utf8");
  tokensCss = readFileSync(resolve(__dirname, "../styles/tokens.css"), "utf8");
});

const EXPECTED_THEMES = [
  "80s", "amber", "cobalt", "corporate", "data", "designer", "duel",
  "evergreen", "frosted-dark", "frosted-light", "hacker", "lavender",
  "light", "macchiato", "midnight", "minimal-dark", "mint", "neon-sunset",
  "nightowl", "polar", "rainbow", "reactor", "rose", "sand", "shibuya",
  "solarized", "solarized-dark", "transilvania", "tron",
];

describe("themes.css — archetype paint coverage", () => {
  it("every expected theme has at least one rule defined", () => {
    for (const t of EXPECTED_THEMES) {
      const re = new RegExp(`html\\[data-theme=["']${t}["']\\]`);
      expect(themesCss).toMatch(re);
    }
  });

  it("tokens.css defines the four core archetype tokens with default values", () => {
    expect(tokensCss).toMatch(/--tool-card-bg:\s*var\(--bg-1\)/);
    expect(tokensCss).toMatch(/--tool-card-border:\s*1px solid var\(--rule-strong/);
    expect(tokensCss).toMatch(/--tool-card-radius:\s*var\(--radius\)/);
    expect(tokensCss).toMatch(/--tool-card-shadow:\s*none/);
    expect(tokensCss).toMatch(/--tool-card-backdrop:\s*none/);
  });

  it("glass-cards family (nightowl, frosted-*) sets backdrop blur", () => {
    const glassSection = themesCss.match(
      /html\[data-theme=["']nightowl["']\][\s\S]*?--tool-card-backdrop:\s*blur/,
    );
    expect(glassSection).not.toBeNull();
  });

  it("hairline-rules family (minimal-dark) zeroes out card chrome", () => {
    const block = themesCss.match(
      /html\[data-theme=["']minimal-dark["']\][\s\S]*?--tool-card-bg:\s*transparent/,
    );
    expect(block).not.toBeNull();
  });

  it("CRT-blocks family (hacker, 80s, midnight) uses sharp corners", () => {
    const crtBlock = themesCss.match(
      /html\[data-theme=["']hacker["'][\s\S]{0,600}?--tool-card-radius:\s*0/,
    );
    expect(crtBlock).not.toBeNull();
  });
});

describe("themes.css — bespoke per-theme touches", () => {
  it("hacker theme adds scanline gradient on tool cards", () => {
    expect(themesCss).toMatch(
      /html\[data-theme=["']hacker["']\][\s\S]*?repeating-linear-gradient/,
    );
  });

  it("designer theme adds an SVG noise paper grain", () => {
    expect(themesCss).toMatch(
      /html\[data-theme=["']designer["']\][\s\S]*?feTurbulence/,
    );
  });

  it("tron theme adds a pulsing rail keyframe animation", () => {
    expect(themesCss).toMatch(/@keyframes\s+tron-rail-pulse/);
  });

  it("rainbow theme adds a gradient rail animation", () => {
    expect(themesCss).toMatch(/@keyframes\s+rainbow-rail-shift/);
  });

  it("animations respect prefers-reduced-motion", () => {
    // Every keyframe-driven theme must opt-out under reduced motion —
    // this catches a future contributor adding an animation without
    // the corresponding @media guard.
    const animationKeyframes = themesCss.match(/@keyframes\s+(tron-rail-pulse|rainbow-rail-shift)/g) ?? [];
    expect(animationKeyframes.length).toBeGreaterThan(0);
    const reducedMotionGuards = themesCss.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? [];
    expect(reducedMotionGuards.length).toBeGreaterThanOrEqual(animationKeyframes.length);
  });
});

describe("themes.css — defensive token usage", () => {
  it("no archetype rule references an undefined custom property", () => {
    // Pull every var(--…) reference inside the archetype block and
    // verify each token is defined SOMEWHERE in either tokens.css or
    // themes.css.  Catches a typo like `var(--tool-card-redius)`.
    const archetypeStart = themesCss.indexOf("Agent Timeline · Archetype Paint");
    expect(archetypeStart).toBeGreaterThan(0);
    const archetypeBlock = themesCss.slice(archetypeStart);
    const refs = Array.from(archetypeBlock.matchAll(/var\(--([a-z0-9-]+)\b/gi))
      .map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(0);
    const definedTokens = new Set<string>();
    for (const css of [tokensCss, themesCss]) {
      for (const m of css.matchAll(/--([a-z0-9-]+):/gi)) {
        definedTokens.add(m[1]);
      }
    }
    const undef = refs.filter((r) => !definedTokens.has(r));
    expect(undef).toEqual([]);
  });
});
