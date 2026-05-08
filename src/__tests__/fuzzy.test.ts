/**
 * Tests for the lightweight fuzzy ranker used by composer suggestions.
 *
 * Covers empty-query passthrough, exclusion of non-matching items,
 * the path-separator and start-of-string bonuses, length-based tie
 * breaking, the limit cap, and the `matches` highlight indices.
 */
import { describe, it, expect } from "vitest";
import { fuzzyRank } from "../utils/fuzzy";

const id = (s: string) => s;

describe("fuzzyRank", () => {
  it("returns all items in input order with score 0 for an empty query", () => {
    const items = ["alpha", "beta", "gamma"];
    const result = fuzzyRank(items, "", id);
    expect(result.map((r) => r.item)).toEqual(items);
    expect(result.every((r) => r.score === 0 && r.matches.length === 0)).toBe(true);
  });

  it("returns an empty array when no items match", () => {
    expect(fuzzyRank(["foo", "bar"], "xyz", id)).toEqual([]);
  });

  it("ranks tighter / shorter matches first and excludes non-matches", () => {
    const items = ["foo.ts", "bar.ts", "foobar.ts"];
    const result = fuzzyRank(items, "foo", id);
    expect(result.map((r) => r.item)).toEqual(["foo.ts", "foobar.ts"]);
  });

  it("awards a bonus when the first match follows a path separator", () => {
    const items = ["src/foo.ts", "srcfoo.ts"];
    const result = fuzzyRank(items, "foo", id);
    expect(result.map((r) => r.item)).toEqual(["src/foo.ts", "srcfoo.ts"]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it("honours the `limit` parameter", () => {
    const items = Array.from({ length: 100 }, (_, i) => `match${i}`);
    const result = fuzzyRank(items, "match", id, 5);
    expect(result).toHaveLength(5);
  });

  it("breaks score ties by preferring the shorter key", () => {
    const items = ["foobar", "foo"];
    const result = fuzzyRank(items, "foo", id);
    expect(result.map((r) => r.item)).toEqual(["foo", "foobar"]);
  });

  it("returns the indices of every matched character in the original key", () => {
    const result = fuzzyRank(["a-b-c"], "abc", id);
    expect(result).toHaveLength(1);
    expect(result[0].matches).toEqual([0, 2, 4]);
  });

  it("performs case-insensitive matching while reporting indices in the original casing", () => {
    const result = fuzzyRank(["FooBar"], "fb", id);
    expect(result).toHaveLength(1);
    expect(result[0].matches).toEqual([0, 3]);
  });
});
