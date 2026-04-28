/**
 * Tests for the pure-logic helper that drives the dynamic-effort chip in the
 * composer. The hook itself (`useClaudeCapabilities`) wires Tauri events and
 * is exercised manually; the bucket-mapping logic lives in
 * `src/utils/effortFill.ts` so it can be tested in isolation.
 *
 * NOTE: if `useClaudeCapabilities.ts` ever computes its own fill level inline
 * instead of importing `effortFillForLevel`, those two implementations MUST
 * stay in sync — adopt the helper and delete the duplicate.
 */
import { describe, it, expect } from "vitest";
import { effortFillForLevel } from "../utils/effortFill";

describe("effortFillForLevel", () => {
  it("returns 0 when the levels list is empty", () => {
    expect(effortFillForLevel("medium", [])).toBe(0);
  });

  it("returns 0 when the current level is not in the list", () => {
    expect(effortFillForLevel("ludicrous", ["low", "medium", "high"])).toBe(0);
  });

  it("returns 0 for the first index of a 5-element list", () => {
    const levels = ["minimal", "low", "medium", "high", "max"];
    expect(effortFillForLevel("minimal", levels)).toBe(0);
  });

  it("returns 3 for the last index of a 5-element list", () => {
    const levels = ["minimal", "low", "medium", "high", "max"];
    expect(effortFillForLevel("max", levels)).toBe(3);
  });

  it("returns a middle value (1 or 2) for a middle index of a 5-element list", () => {
    const levels = ["minimal", "low", "medium", "high", "max"];
    const fill = effortFillForLevel("medium", levels);
    // index 2 of 5 → round(2 * 3 / 4) = round(1.5) = 2
    expect(fill).toBe(2);
    expect(fill).toBeGreaterThanOrEqual(1);
    expect(fill).toBeLessThanOrEqual(2);
  });

  it("maps the second index of a 5-element list to a low-middle bucket", () => {
    const levels = ["minimal", "low", "medium", "high", "max"];
    // index 1 of 5 → round(1 * 3 / 4) = round(0.75) = 1
    expect(effortFillForLevel("low", levels)).toBe(1);
  });

  it("returns 3 for a single-element list (always max)", () => {
    expect(effortFillForLevel("only", ["only"])).toBe(3);
  });

  it("maps the two ends of a 2-element list to 0 and 3", () => {
    const levels = ["low", "high"];
    expect(effortFillForLevel("low", levels)).toBe(0);
    expect(effortFillForLevel("high", levels)).toBe(3);
  });

  it("maps the canonical 3-level set evenly", () => {
    const levels = ["low", "medium", "high"];
    // index 0/2 → 0, 1/2 → round(1.5) = 2, 2/2 → 3
    expect(effortFillForLevel("low", levels)).toBe(0);
    expect(effortFillForLevel("medium", levels)).toBe(2);
    expect(effortFillForLevel("high", levels)).toBe(3);
  });

  it("treats currentLevel as case-sensitive (matches Claude's wire format)", () => {
    const levels = ["low", "medium", "high"];
    // Claude emits lowercase; so should we. Mismatched case is treated as
    // "unknown" and surfaces an empty chip rather than a guess.
    expect(effortFillForLevel("HIGH", levels)).toBe(0);
  });
});
