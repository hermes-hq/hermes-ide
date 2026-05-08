/**
 * `summarizeJsonInput` — tool-input micro-summary helper.
 *
 * The agent timeline used to dump pretty-printed JSON in an
 * unbounded `<pre>` whenever a tool input didn't match a known
 * family.  The summary helper replaces that with a one-line hint;
 * the full payload is one disclosure click away.
 *
 * These tests pin the formatting so callers can rely on the inline
 * label staying readable across upgrades.
 */
import { describe, it, expect } from "vitest";
import {
  summarizeJsonInput,
  prettyJson,
  formatBytes,
} from "../utils/jsonSummary";

describe("summarizeJsonInput — primitives", () => {
  it("null / undefined → '(empty)'", () => {
    expect(summarizeJsonInput(null).text).toBe("(empty)");
    expect(summarizeJsonInput(undefined).text).toBe("(empty)");
  });

  it("string → quoted, truncated past 64 chars", () => {
    expect(summarizeJsonInput("hello").text).toBe('"hello"');
    expect(summarizeJsonInput("").text).toBe("(empty string)");
    const long = "x".repeat(120);
    const out = summarizeJsonInput(long).text;
    // wrapped in quotes; truncated body inside ends with ellipsis.
    expect(out.length).toBeLessThan(70);
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(out.includes('…')).toBe(true);
  });

  it("number / boolean → stringified", () => {
    expect(summarizeJsonInput(42).text).toBe("42");
    expect(summarizeJsonInput(true).text).toBe("true");
    expect(summarizeJsonInput(false).text).toBe("false");
  });
});

describe("summarizeJsonInput — arrays", () => {
  it("empty array → marker", () => {
    expect(summarizeJsonInput([]).text).toBe("[ ] (empty array)");
  });

  it("single item / multi item plurals", () => {
    expect(summarizeJsonInput([1]).text).toMatch(/^\[1 item\]/);
    expect(summarizeJsonInput([1, 2, 3]).text).toMatch(/^\[3 items\]/);
  });

  it("includes byte size hint", () => {
    const out = summarizeJsonInput([1, 2, 3]).text;
    expect(out).toMatch(/· \d+ B$/);
  });
});

describe("summarizeJsonInput — objects (smart shapes)", () => {
  it("`command` shape is surfaced verbatim (Bash-like)", () => {
    expect(summarizeJsonInput({ command: "git status -s" }).text).toBe(
      "command: git status -s",
    );
  });

  it("`file_path` shape shows the path only (Read/Edit-like)", () => {
    expect(summarizeJsonInput({ file_path: "/tmp/foo.ts" }).text).toBe("/tmp/foo.ts");
  });

  it("`pattern` shape shows the pattern (Grep-like)", () => {
    expect(summarizeJsonInput({ pattern: "TODO\\(.*\\)" }).text).toBe(
      "pattern: TODO\\(.*\\)",
    );
  });

  it("`url` shape surfaces the URL (Fetch-like)", () => {
    expect(summarizeJsonInput({ url: "https://example.com/api" }).text).toBe(
      "https://example.com/api",
    );
  });

  it("generic object → key count + size", () => {
    const out = summarizeJsonInput({ a: 1, b: 2, c: 3 }).text;
    expect(out).toMatch(/^3 keys · /);
  });

  it("single-key object uses singular noun", () => {
    const out = summarizeJsonInput({ foo: { nested: true } }).text;
    expect(out).toMatch(/^1 key · /);
  });

  it("empty object → marker", () => {
    expect(summarizeJsonInput({}).text).toBe("{ } (empty object)");
  });

  it("smart-shape value gets truncated when too long", () => {
    const longCmd = "echo " + "x".repeat(200);
    const out = summarizeJsonInput({ command: longCmd }).text;
    expect(out.length).toBeLessThan(80);
    expect(out.startsWith("command: echo ")).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it("non-string command field falls through to generic key-count", () => {
    expect(summarizeJsonInput({ command: 42, extra: 1 }).text).toMatch(
      /^2 keys · /,
    );
  });
});

describe("formatBytes", () => {
  it("under 1024 → bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(523)).toBe("523 B");
  });
  it("kilobytes with decimal under 100 KB", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(50000)).toBe("48.8 KB");
  });
  it("integer kilobytes between 100–1024 KB", () => {
    expect(formatBytes(200_000)).toBe("195 KB");
  });
  it("megabytes past 1 MB", () => {
    expect(formatBytes(2_000_000)).toBe("1.9 MB");
  });
});

describe("prettyJson", () => {
  it("indents with 2 spaces", () => {
    expect(prettyJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("falls back gracefully on circular references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    // Should NOT throw — falls back to String(input).
    const out = prettyJson(a);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });
});
