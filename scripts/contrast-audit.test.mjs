import { describe, expect, it } from "vitest";
import {
  auditThemes,
  contrast,
  contrastPairs,
  loadThemeTokens,
  parseColour,
  substitute,
  themeTokens,
  THEMES,
  TEXT_MIN,
  UI_MIN,
} from "./contrast-audit.mjs";
import { THEME_OPTIONS } from "../src/utils/themeManager";

const tokens = loadThemeTokens();

describe("contrast audit — the colour maths", () => {
  it("computes WCAG ratios", () => {
    expect(contrast(parseColour("#000"), parseColour("#fff"))).toBeCloseTo(21, 5);
    expect(contrast(parseColour("#767676"), parseColour("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("resolves var() chains, fallbacks, rgba() and color-mix()", () => {
    const vars = { "--a": "#ff0000", "--b": "var(--a)", "--c": "color-mix(in srgb, var(--b) 50%, transparent)" };
    expect(parseColour(substitute("var(--b)", vars))).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColour(substitute("var(--missing, #00ff00)", vars))).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    const half = parseColour(substitute("var(--c)", vars));
    expect(half.a).toBeCloseTo(0.5);
    expect(half.r).toBeCloseTo(255);
    expect(parseColour("rgba(10, 20, 30, .25)")).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
  });

  it("an undefined token is an error, not a pass", () => {
    expect(() => substitute("var(--nope)", {})).toThrow(/undefined token --nope/);
  });

  it("fails a theme whose pair is under the threshold (negative control)", () => {
    const [theme] = Object.values(
      themeTokens([
        ':root { --bg-1: #ffffff; --text-2: #aaaaaa; }',
        'html[data-theme="t"] { --text-3: #eeeeee; }',
      ], ["t"]),
    );
    const results = auditThemes({ t: theme }, [
      { fg: "--text-2", bg: ["--bg-1"], min: TEXT_MIN, kind: "text", why: "test" },
      { fg: "--text-3", bg: ["--bg-1"], min: UI_MIN, kind: "non-text", why: "test" },
      { fg: "--missing", bg: ["--bg-1"], min: TEXT_MIN, kind: "text", why: "test" },
    ]);
    expect(results.map((r) => r.pass)).toEqual([false, false, false]);
    expect(results[0].ratio).toBeLessThan(TEXT_MIN);
    expect(results[2].error).toMatch(/undefined token/);
  });

  it("reads theme blocks, not descendant rules", () => {
    const t = themeTokens(
      [':root { --x: #000000; } html[data-theme="t"] { --x: #111111; } html[data-theme="t"] .topbar { --x: #222222; }'],
      ["t"],
    );
    expect(t.t["--x"]).toBe("#111111");
  });
});

describe("contrast audit — every shipped theme meets the control-set rules", () => {
  it("checks exactly the themes the app offers", () => {
    expect([...THEMES].sort()).toEqual(THEME_OPTIONS.map((t) => t.id).sort());
    for (const theme of THEMES) expect(Object.keys(tokens[theme]).length).toBeGreaterThan(50);
  });

  it("checks text at 4.5:1 and field edges, focus ring and brass marks at 3:1", () => {
    const pairs = contrastPairs();
    const find = (fg, bg) => pairs.find((p) => p.fg === fg && p.bg.join("+") === bg);
    expect(find("--text-3", "--bg-2")?.min).toBe(4.5);
    expect(find("--primary-fg", "--primary-bg")?.min).toBe(4.5);
    expect(find("--field-border", "--bg-1")?.min).toBe(3);
    expect(find("--focus-ring", "--bg-0")?.min).toBe(3);
  });

  for (const theme of THEMES) {
    it(`${theme}: every pair passes`, () => {
      const results = auditThemes({ [theme]: tokens[theme] });
      const failures = results
        .filter((r) => !r.pass)
        .map((r) => `${r.fg} on ${r.bg.join(" + ")}: ${r.error ?? r.ratio.toFixed(2) + ":1"} (min ${r.min}, ${r.why})`);
      expect(failures).toEqual([]);
      expect(results.length).toBe(contrastPairs().length);
    });
  }
});
