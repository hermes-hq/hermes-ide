/**
 * Agent block renderer bug audit — failing tests proving concrete bugs.
 *
 * Each `describe` block proves one bug found by inspection of
 * /Users/gabrielanhaia/WebstormProjects/h-ide/src/agent/blocks/*. These
 * tests are intentionally written to FAIL on `main` so the bugs are visible
 * in CI; once fixed they should pass.
 *
 * Bug IDs match the audit summary returned alongside this file.
 */
import { describe, expect, it } from "vitest";
import { renderToString, renderToStaticMarkup } from "react-dom/server";
import hljs from "highlight.js/lib/common";

import { FileToolBlock } from "../agent/blocks/FileToolBlock";
import { CodeFence } from "../agent/blocks/CodeFence";
import { formatElapsedSeconds } from "../agent/blocks/ThinkingBlock";
import type {
  ContentBlock,
  ImageBlockData,
  ToolResultBlockData,
  ToolUseBlockData,
} from "../agent/types";

function toolUse(
  name: string,
  input: Record<string, unknown> = {},
  id = "tu_1",
): ToolUseBlockData {
  return { type: "tool_use", id, name, input };
}

function toolResult(
  content: string | ContentBlock[],
  isError = false,
  id = "tu_1",
): ToolResultBlockData {
  return {
    type: "tool_result",
    tool_use_id: id,
    content,
    is_error: isError,
  };
}

// ---------------------------------------------------------------------------
// BUG-1: Read summary uses raw `offset`, producing impossible "line 0" rows.
//
// FileToolBlock.computeSummary (variant === "read"):
//   `lines ${offset}–${offset + limit - 1}`
// when offset === 0 and limit === 5, that renders "lines 0–4". Files have no
// line 0; Claude's Read tool input expects 1-based line numbers (per its
// public contract). The displayed summary is incorrect for the offset=0 case.
// ---------------------------------------------------------------------------
describe("BUG-1 — Read summary off-by-one when offset=0", () => {
  it("does not show a non-existent 'line 0' in the summary", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "src/foo.ts", offset: 0, limit: 5 })}
        result={toolResult("ok")}
      />,
    );
    // Either render "lines 1–5" (treating offset=0 as start) or omit the
    // summary; "lines 0" is wrong because line 0 does not exist.
    expect(html).not.toMatch(/lines 0[–-]/);
  });
});

// ---------------------------------------------------------------------------
// BUG-2: stringifyContent dumps the entire base64 payload of an image
// tool_result block as JSON. The Read tool can return image content blocks
// (Claude's Read on PNG/JPG screenshots returns ImageBlockData). The current
// `stringifyContent` (FileToolBlock.tsx and ExecToolBlock.tsx and
// SearchToolBlock.tsx) catches `text` blocks but every other block type,
// including images, falls through to `JSON.stringify(b)` — which means the
// raw base64 is rendered into the DOM.
// ---------------------------------------------------------------------------
describe("BUG-2 — image tool_result blocks dump base64 into the DOM", () => {
  it("does not embed the raw base64 payload of an image block", () => {
    const fakeBase64 = "AAAA".repeat(2_000); // 8000 chars → easy to detect.
    const imageBlock: ImageBlockData = {
      type: "image",
      source: {
        type: "base64",
        media_type: "image/png",
        data: fakeBase64,
      },
    };
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "/tmp/screenshot.png" })}
        result={toolResult([imageBlock])}
      />,
    );
    // The component should not render the raw base64 — either drop the
    // image, render an `[image]` placeholder, or surface a thumbnail. The
    // current implementation prints the entire JSON including the data
    // string verbatim.
    expect(html).not.toContain(fakeBase64);
  });
});

// ---------------------------------------------------------------------------
// BUG-3: When the highlight.js common bundle does NOT carry an explicit
// language hint (e.g. the user opens an Elixir / Clojure / Scala / Dart file
// — `languageFromPath` maps these but the common bundle doesn't), CodeFence
// silently falls back to plain HTML-escaped text. The data-language attribute
// still says e.g. "scala" so observers think they got highlighting; in
// practice no `<span class="hljs-…">` tokens are produced. This is a
// rendering-fidelity bug: the user sees a Scala-labelled block with no
// colour while every other Java/Kotlin block gets coloured.
// ---------------------------------------------------------------------------
describe("BUG-3 — explicit language hint silently produces unhighlighted output", () => {
  it("emits highlight.js <span> tokens when language='scala' is requested", () => {
    // Sanity: `getLanguage('scala')` should be defined; common bundle does
    // not include scala, exposing the silent-fallback path.
    expect(hljs.getLanguage("scala")).toBeUndefined();

    const code = "object Hello { def main(args: Array[String]): Unit = println(\"hi\") }";
    const html = renderToStaticMarkup(<CodeFence code={code} language="scala" />);
    // The pill must say scala — that part already works.
    expect(html).toContain('data-language="scala"');
    // The bug: no hljs span tokens are rendered, so the body is just escaped
    // plaintext. A correct implementation would either auto-detect on
    // unsupported hints, lazy-load the language pack, or warn the caller.
    expect(html).toMatch(/class="hljs-[a-z-]+"/);
  });
});

// ---------------------------------------------------------------------------
// BUG-4: formatElapsedSeconds returns nonsense like "-0.4s" for negative
// inputs (clock skew). The internal call site in ThinkingBlock guards with
// Math.max(0, …); however the helper is `export`ed and its contract should
// be defensive — and a future caller could (and reasonably would) pass the
// raw delta. The contract is "compact mono-number string"; "-0.4s" is not a
// reasonable elapsed render.
// ---------------------------------------------------------------------------
describe("BUG-4 — formatElapsedSeconds emits a negative duration", () => {
  it("renders a non-negative duration even when input is negative", () => {
    // Negative ms can arise from clock skew when comparing
    // `Date.now() - startedAt` across timezones / NTP corrections.
    expect(formatElapsedSeconds(-400)).not.toMatch(/^-/);
    expect(formatElapsedSeconds(-1_000)).not.toMatch(/^-/);
  });
});
