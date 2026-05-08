/**
 * Tests for the composer @mention helpers.
 *
 * Covers:
 *   1. getActiveMention — caret-relative detection of an `@mention` token,
 *      including the "preceded by whitespace or start" rule, whitespace
 *      termination, and the closest-`@`-wins tie-break in `@@`.
 *   2. replaceMention — substitution that always trails a single space so
 *      the user can keep typing.
 */
import { describe, it, expect } from "vitest";
import { getActiveMention, replaceMention } from "../utils/mentions";

describe("getActiveMention", () => {
  it("returns null for empty text", () => {
    expect(getActiveMention("", 0)).toBeNull();
  });

  it("returns null when caret is at position 0", () => {
    expect(getActiveMention("@foo", 0)).toBeNull();
  });

  it("matches a bare `@` at the very start", () => {
    expect(getActiveMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("matches `@foo` at the very start", () => {
    expect(getActiveMention("@foo", 4)).toEqual({ start: 0, end: 4, query: "foo" });
  });

  it("matches a mention preceded by a space", () => {
    expect(getActiveMention("hi @foo", 7)).toEqual({ start: 3, end: 7, query: "foo" });
  });

  it("rejects `@` glued to a non-space character (email-style)", () => {
    expect(getActiveMention("hi@foo", 6)).toBeNull();
  });

  it("returns null when whitespace appears between `@` and caret", () => {
    expect(getActiveMention("@foo bar", 8)).toBeNull();
  });

  it("matches up to (but not past) the terminating space", () => {
    expect(getActiveMention("@foo bar", 4)).toEqual({ start: 0, end: 4, query: "foo" });
  });

  it("treats newline as whitespace before the `@`", () => {
    expect(getActiveMention("a\n@foo", 6)).toEqual({ start: 2, end: 6, query: "foo" });
  });

  it("supports multi-byte (BMP) characters in the query", () => {
    expect(getActiveMention("@é", 2)).toEqual({ start: 0, end: 2, query: "é" });
  });

  it("picks the LAST `@` in a run of consecutive `@`s", () => {
    expect(getActiveMention("@@", 2)).toEqual({ start: 1, end: 2, query: "" });
  });

  it("only extends the mention up to the caret, not past it", () => {
    expect(getActiveMention("@foobar", 4)).toEqual({ start: 0, end: 4, query: "foo" });
  });
});

describe("replaceMention", () => {
  it("inserts replacement and appends a trailing space when missing", () => {
    const text = "@fo";
    const mention = { start: 0, end: 3, query: "fo" };
    const result = replaceMention(text, mention, "src/foo.ts");
    expect(result).toEqual({ text: "src/foo.ts ", caret: 11 });
  });

  it("does not add a second space when the replacement already ends with one", () => {
    const text = "@fo";
    const mention = { start: 0, end: 3, query: "fo" };
    const result = replaceMention(text, mention, "src/foo.ts ");
    expect(result.text).toBe("src/foo.ts ");
    expect(result.text.endsWith("  ")).toBe(false);
    expect(result.caret).toBe(11);
  });

  it("replaces a mid-text mention and preserves following content", () => {
    const text = "hi @b world";
    const mention = { start: 3, end: 5, query: "b" };
    const result = replaceMention(text, mention, "src/bar.ts");
    expect(result).toEqual({ text: "hi src/bar.ts  world", caret: 14 });
  });
});
