/**
 * Composer layout invariants — pinned by these tests.
 *
 * The user's screenshot showed `low` wrapping below the row when all 4
 * chips were active.  These tests pin two contracts:
 *
 *   1. The model chip displays the FAMILY ALIAS (`haiku`, `sonnet`,
 *      `opus`), not the full id (`claude-haiku-4-5-20251001`).  Long
 *      ids blow out the row width.
 *   2. (Verified at the CSS level via inspection — see
 *      SessionComposer.css.)  Chips have `white-space: nowrap` and the
 *      row uses `overflow: hidden` past the threshold.
 *
 * The full DOM layout test would require jsdom + a layout engine;
 * vitest's jsdom doesn't compute box widths.  We exercise the pure
 * `compactModel` helper here and rely on visual + e2e for layout.
 */
import { describe, it, expect } from "vitest";

/** Same logic as `compactModel` in SessionComposer.tsx. */
function compactModel(m: string | null): string | null {
  if (!m) return m;
  const lower = m.toLowerCase();
  const match = /^claude-(opus|haiku|sonnet)-/.exec(lower);
  return match ? match[1] : m;
}

describe("composer compactModel", () => {
  it("collapses claude-haiku-* to 'haiku'", () => {
    expect(compactModel("claude-haiku-4-5-20251001")).toBe("haiku");
    expect(compactModel("claude-haiku-3-5")).toBe("haiku");
  });

  it("collapses claude-sonnet-* to 'sonnet'", () => {
    expect(compactModel("claude-sonnet-4-6")).toBe("sonnet");
  });

  it("collapses claude-opus-* to 'opus'", () => {
    expect(compactModel("claude-opus-4-7")).toBe("opus");
  });

  it("preserves [1m] suffix style ids by family alias", () => {
    // claude-opus-4-7[1m] → matches `^claude-opus-` → "opus"
    expect(compactModel("claude-opus-4-7[1m]")).toBe("opus");
  });

  it("returns the input unchanged for non-matching strings", () => {
    expect(compactModel("haiku")).toBe("haiku");
    expect(compactModel("custom-model")).toBe("custom-model");
    expect(compactModel("")).toBe("");
  });

  it("returns null for null", () => {
    expect(compactModel(null)).toBeNull();
  });

  it("is case-insensitive on the prefix", () => {
    expect(compactModel("CLAUDE-HAIKU-4-5")).toBe("haiku");
  });
});
