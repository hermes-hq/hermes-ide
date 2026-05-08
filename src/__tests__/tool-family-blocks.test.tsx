/**
 * Phase 3 (v1.0.0 redesign) — tool family visual languages.
 *
 * Pin the rendered DOM for each of the five family-specific tool blocks
 * (file / exec / search / web / generic) and the router that picks them.
 * Each family has a distinct glyph, status data attribute, and chrome — these
 * tests guard against regressions when we wire streaming patterns (Phase 5)
 * and the unified diff (Phase 4) on top.
 *
 * Rendering uses `react-dom/server`'s `renderToString` (the existing pattern).
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { FileToolBlock } from "../agent/blocks/FileToolBlock";
import { ExecToolBlock } from "../agent/blocks/ExecToolBlock";
import { SearchToolBlock } from "../agent/blocks/SearchToolBlock";
import { WebToolBlock } from "../agent/blocks/WebToolBlock";
import { GenericToolBlock } from "../agent/blocks/GenericToolBlock";
import { ToolUseBlock } from "../agent/blocks/ToolUseBlock";
import { GLYPHS } from "../agent/blocks/glyphs";
import type { ToolResultBlockData, ToolUseBlockData } from "../agent/types";

function toolUse(
  name: string,
  input: Record<string, unknown> = {},
  id = "tu_1",
): ToolUseBlockData {
  return { type: "tool_use", id, name, input };
}

function toolResult(
  text: string,
  isError = false,
  id = "tu_1",
): ToolResultBlockData {
  return {
    type: "tool_result",
    tool_use_id: id,
    content: text,
    is_error: isError,
  };
}

describe("FileToolBlock", () => {
  it("renders the file glyph and path in the header", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "src/foo.ts" })}
        result={toolResult("line 1\nline 2")}
      />,
    );
    expect(html).toContain("agent-tool-file");
    expect(html).toContain(GLYPHS.file);
    expect(html).toContain("src/foo.ts");
  });

  it("uses success status when result is non-error", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "src/foo.ts" })}
        result={toolResult("ok")}
      />,
    );
    expect(html).toContain('data-status="success"');
  });

  it("uses error status when result.is_error is true", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "src/foo.ts" })}
        result={toolResult("ENOENT", true)}
      />,
    );
    expect(html).toContain('data-status="error"');
  });

  it("uses running status when result is missing", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "src/foo.ts" })}
        result={undefined}
      />,
    );
    expect(html).toContain('data-status="running"');
  });

  it("renders a +N, −M summary for Edit", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Edit", {
          file_path: "src/foo.ts",
          old_string: "a\nb",
          new_string: "c\nd\ne",
        })}
        result={toolResult("ok")}
      />,
    );
    expect(html).toContain("agent-tool-file-summary");
    expect(html).toContain("+3, −2");
  });

  it("collapses bodies longer than 8 lines by default", () => {
    const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Read", { file_path: "src/foo.ts" })}
        result={toolResult(longContent)}
      />,
    );
    expect(html).toContain("agent-tool-file-disclosure");
    expect(html).toMatch(/Show.*20.*more lines/);
    expect(html).not.toContain("agent-tool-file-body");
  });

  it("renders a UnifiedDiff body for Edit tool calls", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Edit", {
          file_path: "src/foo.ts",
          old_string: "alpha\nbravo",
          new_string: "alpha\ncharlie",
        })}
        result={toolResult("ok")}
      />,
    );
    // The unified-diff component is in play.
    expect(html).toContain("agent-diff");
    expect(html).toContain("agent-diff-row");
    // One add + one remove + one context row.
    expect(html).toContain("agent-diff-add");
    expect(html).toContain("agent-diff-remove");
    expect(html).toContain("agent-diff-context");
    expect(html).toContain("alpha");
    expect(html).toContain("bravo");
    expect(html).toContain("charlie");
  });

  it("renders a Write as an all-additions diff body", () => {
    const html = renderToString(
      <FileToolBlock
        block={toolUse("Write", {
          file_path: "src/new.ts",
          content: "first\nsecond\nthird",
        })}
        result={toolResult("ok")}
      />,
    );
    expect(html).toContain("agent-diff");
    expect(html).toContain("agent-diff-add");
    expect(html).not.toContain("agent-diff-remove");
    expect(html).toContain("first");
    expect(html).toContain("second");
    expect(html).toContain("third");
  });
});

describe("ExecToolBlock", () => {
  it("renders the exec glyph + command, no card", () => {
    const html = renderToString(
      <ExecToolBlock
        block={toolUse("Bash", { command: "ls -la" })}
        result={toolResult("file1\nfile2")}
      />,
    );
    expect(html).toContain("agent-tool-exec");
    expect(html).toContain(GLYPHS.exec);
    expect(html).toContain("ls -la");
    // No card border class.
    expect(html).not.toContain("agent-bash-block");
  });

  it("emits data-status=running when result is missing", () => {
    const html = renderToString(
      <ExecToolBlock
        block={toolUse("Bash", { command: "sleep 1" })}
        result={undefined}
      />,
    );
    expect(html).toContain('data-status="running"');
  });

  it("emits data-status=success when result is non-error", () => {
    const html = renderToString(
      <ExecToolBlock
        block={toolUse("Bash", { command: "echo ok" })}
        result={toolResult("ok")}
      />,
    );
    expect(html).toContain('data-status="success"');
  });

  it("emits data-status=error when result is_error is true", () => {
    const html = renderToString(
      <ExecToolBlock
        block={toolUse("Bash", { command: "exit 1" })}
        result={toolResult("oops", true)}
      />,
    );
    expect(html).toContain('data-status="error"');
  });

  it("collapses output longer than 12 lines to a tail + disclosure", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `out ${i + 1}`).join(
      "\n",
    );
    const html = renderToString(
      <ExecToolBlock
        block={toolUse("Bash", { command: "yes | head -30" })}
        result={toolResult(longOutput)}
      />,
    );
    expect(html).toContain("agent-tool-exec-disclosure");
    expect(html).toMatch(/26.*hidden lines/);
    expect(html).toContain("out 30");
    expect(html).not.toContain("out 1\n");
  });
});

describe("SearchToolBlock", () => {
  it("renders the search glyph and italic query line", () => {
    const html = renderToString(
      <SearchToolBlock
        block={toolUse("Grep", { pattern: "useState", path: "src/" })}
        result={toolResult("src/foo.tsx:42:const [x, setX] = useState(0)")}
      />,
    );
    expect(html).toContain("agent-tool-search");
    expect(html).toContain(GLYPHS.search);
    expect(html).toContain("<em>");
    expect(html).toContain("useState");
    expect(html).toContain("src/");
  });

  it("parses grep-style results into path + line + snippet", () => {
    const html = renderToString(
      <SearchToolBlock
        block={toolUse("Grep", { pattern: "x" })}
        result={toolResult("src/a.ts:1:foo\nsrc/b.ts:2:bar")}
      />,
    );
    expect(html).toContain("agent-tool-search-path");
    expect(html).toContain("agent-tool-search-line");
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/b.ts");
  });

  it("highlights matched substring with <mark>", () => {
    const html = renderToString(
      <SearchToolBlock
        block={toolUse("Grep", { pattern: "useState" })}
        result={toolResult("src/foo.tsx:1:useState(0)")}
      />,
    );
    expect(html).toContain("<mark>useState</mark>");
  });

  it("treats Glob results as paths without snippets", () => {
    const html = renderToString(
      <SearchToolBlock
        block={toolUse("Glob", { pattern: "**/*.ts" })}
        result={toolResult("src/a.ts\nsrc/b.ts")}
      />,
    );
    expect(html).toContain("src/a.ts");
    expect(html).toContain("src/b.ts");
    expect(html).not.toContain("agent-tool-search-line");
  });
});

describe("WebToolBlock", () => {
  it("renders the citation glyph + URL in mono and excerpt in serif", () => {
    const html = renderToString(
      <WebToolBlock
        block={toolUse("WebFetch", { url: "https://example.com/x" })}
        result={toolResult("Some excerpt body.")}
      />,
    );
    expect(html).toContain("agent-tool-web");
    expect(html).toContain(GLYPHS.citation);
    expect(html).toContain("https://example.com/x");
    expect(html).toContain("agent-tool-web-excerpt");
    expect(html).toContain("Some excerpt body.");
  });

  it("truncates long excerpts and exposes a Read full disclosure", () => {
    const longExcerpt =
      "First sentence is here. Second sentence follows. " +
      "And more and more text to push past the truncation limit. ".repeat(
        10,
      ) +
      "Trailing.";
    const html = renderToString(
      <WebToolBlock
        block={toolUse("WebFetch", { url: "https://example.com/x" })}
        result={toolResult(longExcerpt)}
      />,
    );
    expect(html).toContain("agent-tool-web-disclosure");
    expect(html).toContain("Read full");
  });
});

describe("GenericToolBlock", () => {
  it("renders bare-bones — italic name + collapsed input toggle", () => {
    const html = renderToString(
      <GenericToolBlock
        block={toolUse("CustomTool", { foo: 1 })}
        result={toolResult("done")}
      />,
    );
    expect(html).toContain("agent-tool-generic");
    expect(html).toContain("agent-tool-generic-name");
    expect(html).toContain("CustomTool");
    expect(html).toContain("agent-tool-generic-input-toggle");
    expect(html).toContain(GLYPHS.disclosure);
    // Default-collapsed: no input pre-block in DOM.
    expect(html).not.toContain("agent-tool-generic-input-pre");
  });
});

describe("ToolUseBlock router", () => {
  it("dispatches to the file family for Read/Write/Edit/NotebookEdit", () => {
    const html = renderToString(
      <ToolUseBlock
        block={toolUse("Edit", {
          file_path: "src/foo.ts",
          old_string: "a",
          new_string: "b",
        })}
        result={toolResult("ok")}
      />,
    );
    expect(html).toContain("agent-tool-file");
    expect(html).not.toContain("agent-tool-exec");
  });

  it("dispatches to the exec family for Bash/Run", () => {
    const html = renderToString(
      <ToolUseBlock
        block={toolUse("Bash", { command: "echo hi" })}
        result={toolResult("hi")}
      />,
    );
    expect(html).toContain("agent-tool-exec");
    expect(html).not.toContain("agent-tool-file");
  });

  it("dispatches to the search family for Grep/Glob", () => {
    const html = renderToString(
      <ToolUseBlock
        block={toolUse("Grep", { pattern: "x" })}
        result={toolResult("src/a.ts:1:x")}
      />,
    );
    expect(html).toContain("agent-tool-search");
  });

  it("dispatches to the web family for WebFetch/WebSearch", () => {
    const html = renderToString(
      <ToolUseBlock
        block={toolUse("WebFetch", { url: "https://example.com" })}
        result={toolResult("excerpt")}
      />,
    );
    expect(html).toContain("agent-tool-web");
  });

  it("dispatches to the generic fallback for unknown tools", () => {
    const html = renderToString(
      <ToolUseBlock
        block={toolUse("UnknownTool", { foo: 1 })}
        result={toolResult("done")}
      />,
    );
    expect(html).toContain("agent-tool-generic");
  });
});
