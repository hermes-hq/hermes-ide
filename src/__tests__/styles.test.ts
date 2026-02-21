import { describe, it, expect } from "vitest";
import {
  BUILT_IN_STYLES,
  mergeStyles,
  validateCustomStyle,
  type SelectedStyle,
} from "../lib/styles";

describe("BUILT_IN_STYLES", () => {
  it("has 14 built-in styles", () => {
    expect(BUILT_IN_STYLES.length).toBe(14);
  });

  it("all styles have required fields", () => {
    for (const style of BUILT_IN_STYLES) {
      expect(style.id).toBeTruthy();
      expect(style.label).toBeTruthy();
      expect(style.levels).toHaveLength(5);
      expect(style.builtIn).toBe(true);
      for (const lvl of style.levels) {
        expect(lvl.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate IDs", () => {
    const ids = BUILT_IN_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("mergeStyles", () => {
  it("returns empty string for empty selections", () => {
    expect(mergeStyles([], BUILT_IN_STYLES)).toBe("");
  });

  it("returns single style instruction for one selection", () => {
    const result = mergeStyles([{ id: "concise", level: 3 }], BUILT_IN_STYLES);
    expect(result).toContain("concise");
    expect(result.length).toBeGreaterThan(0);
  });

  it("level 1 returns the first level instruction", () => {
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    const result = mergeStyles([{ id: "concise", level: 1 }], BUILT_IN_STYLES);
    expect(result).toBe(concise.levels[0]);
  });

  it("level 5 returns the fifth level instruction", () => {
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    const result = mergeStyles([{ id: "concise", level: 5 }], BUILT_IN_STYLES);
    expect(result).toBe(concise.levels[4]);
  });

  it("combines multiple style instructions", () => {
    const result = mergeStyles(
      [
        { id: "concise", level: 3 },
        { id: "code-heavy", level: 3 },
      ],
      BUILT_IN_STYLES,
    );
    expect(result).toContain("concise");
    expect(result).toContain("code");
  });

  it("is deterministic", () => {
    const selections: SelectedStyle[] = [
      { id: "concise", level: 4 },
      { id: "formal", level: 2 },
    ];
    const a = mergeStyles(selections, BUILT_IN_STYLES);
    const b = mergeStyles(selections, BUILT_IN_STYLES);
    expect(a).toBe(b);
  });

  it("skips unknown style IDs silently", () => {
    const result = mergeStyles(
      [
        { id: "concise", level: 3 },
        { id: "nonexistent-style", level: 3 },
      ],
      BUILT_IN_STYLES,
    );
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    expect(result).toBe(concise.levels[2]);
  });

  it("clamps level to valid range", () => {
    const concise = BUILT_IN_STYLES.find((s) => s.id === "concise")!;
    // Level 0 should clamp to index 0 (level 1)
    expect(mergeStyles([{ id: "concise", level: 0 }], BUILT_IN_STYLES)).toBe(concise.levels[0]);
    // Level 10 should clamp to index 4 (level 5)
    expect(mergeStyles([{ id: "concise", level: 10 }], BUILT_IN_STYLES)).toBe(concise.levels[4]);
  });
});

describe("validateCustomStyle", () => {
  it("rejects empty label", () => {
    const result = validateCustomStyle(
      { label: "", levels: ["a", "b", "c", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Label");
  });

  it("rejects empty level instruction", () => {
    const result = validateCustomStyle(
      { label: "My Style", levels: ["a", "b", "", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("level");
  });

  it("rejects duplicate label (case-insensitive)", () => {
    const result = validateCustomStyle(
      { label: "concise", levels: ["a", "b", "c", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("accepts valid custom style", () => {
    const result = validateCustomStyle(
      { label: "Unique Style", levels: ["a", "b", "c", "d", "e"] },
      BUILT_IN_STYLES,
    );
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
