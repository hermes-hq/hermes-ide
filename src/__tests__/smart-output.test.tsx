/**
 * Tests for the SmartOutput component and its pure helpers.
 *
 *   - `stripAnsi` clears CSI / OSC escape sequences without nibbling
 *     surrounding text.
 *   - `tryParseJson` only fires for object/array roots (not for bare
 *     numbers or strings that happen to be JSON-parseable).
 *   - `<SmartOutput>` chooses the right rendering strategy: code-fence
 *     when a language hint is given or JSON is detected, plain `<pre>`
 *     for everything else.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SmartOutput, stripAnsi, tryParseJson } from "../agent/blocks/SmartOutput";

describe("stripAnsi", () => {
  it("removes CSI colour codes", () => {
    expect(stripAnsi("\x1b[31mhello\x1b[0m world")).toBe("hello world");
  });

  it("removes CSI cursor / clear sequences", () => {
    expect(stripAnsi("foo\x1b[2Jbar\x1b[Hbaz")).toBe("foobarbaz");
  });

  it("removes OSC sequences (terminal title etc.)", () => {
    expect(stripAnsi("a\x1b]0;title\x07b")).toBe("ab");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("just regular output\nwith a newline")).toBe(
      "just regular output\nwith a newline",
    );
  });

  it("keeps bracket characters that aren't part of escape sequences", () => {
    expect(stripAnsi("[INFO] starting [build]")).toBe("[INFO] starting [build]");
  });
});

describe("tryParseJson", () => {
  it("pretty-prints a valid object", () => {
    const out = tryParseJson('{"a":1,"b":[2,3]}');
    expect(out).toBe(`{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}`);
  });

  it("pretty-prints a valid array", () => {
    const out = tryParseJson("[1,2,3]");
    expect(out).toBe(`[\n  1,\n  2,\n  3\n]`);
  });

  it("returns undefined for plain text", () => {
    expect(tryParseJson("hello world")).toBeUndefined();
  });

  it("returns undefined for bare numbers (don't aggressively reformat)", () => {
    expect(tryParseJson("42")).toBeUndefined();
  });

  it("returns undefined for bare strings", () => {
    expect(tryParseJson('"already a string"')).toBeUndefined();
  });

  it("returns undefined for malformed JSON that happens to start with {", () => {
    expect(tryParseJson("{not json}")).toBeUndefined();
  });

  it("ignores leading/trailing whitespace before deciding", () => {
    expect(tryParseJson("\n  [1, 2]  \n")).toBe(`[\n  1,\n  2\n]`);
  });
});

describe("<SmartOutput>", () => {
  it("renders a CodeFence when a language hint is provided", () => {
    const html = renderToStaticMarkup(
      <SmartOutput text="const x = 1;" languageHint="typescript" />,
    );
    expect(html).toContain("agent-code-fence");
    expect(html).toContain('data-language="typescript"');
  });

  it("renders a CodeFence for JSON-detected output (no hint)", () => {
    const html = renderToStaticMarkup(
      <SmartOutput text='{"a":1}' />,
    );
    expect(html).toContain("agent-code-fence");
    expect(html).toContain('data-language="json"');
  });

  it("falls back to a plain <pre> for unstructured text", () => {
    const html = renderToStaticMarkup(
      <SmartOutput text="just some logs" />,
    );
    expect(html).toContain("<pre");
    expect(html).not.toContain("agent-code-fence");
    expect(html).toContain("just some logs");
  });

  it("strips ANSI codes before rendering", () => {
    // JSX attribute string literals don't interpret JS backslash escapes,
    // so we pass the prop via an expression to get the real ESC byte.
    const text = "\x1b[31merror\x1b[0m: oops";
    const html = renderToStaticMarkup(<SmartOutput text={text} />);
    expect(html).toContain("error: oops");
    expect(html).not.toContain("\x1b");
  });

  it("respects a custom className on the plain <pre> fallback", () => {
    const html = renderToStaticMarkup(
      <SmartOutput text="logs" className="my-output" />,
    );
    expect(html).toContain('class="my-output"');
  });
});
