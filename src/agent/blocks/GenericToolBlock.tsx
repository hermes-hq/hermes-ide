import { useState } from "react";
import type { ContentBlock, ToolResultBlockData, ToolUseBlockData } from "../types";
import { GLYPHS } from "./glyphs";
import { CodeFence } from "./CodeFence";
import { prettyJson, summarizeJsonInput } from "../../utils/jsonSummary";

interface GenericToolBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

/**
 * Fallback renderer for tools that don't fit any known family.
 *
 * Surfaces a one-line micro-summary of the input (key count + size,
 * or a hint extracted from common shapes like `command` / `file_path`
 * / `pattern`).  Full payload is one click away inside a syntax-
 * highlighted code fence so deeply-nested inputs no longer dump as
 * a wall of unstyled JSON.
 *
 * Result text uses the same disclosure pattern when long; short
 * results render inline.
 */
export function GenericToolBlock({ block, result }: GenericToolBlockProps) {
  const [open, setOpen] = useState(false);
  const status = !result ? "running" : result.is_error ? "error" : "success";

  const summary = summarizeJsonInput(block.input);
  const inputJson = open ? prettyJson(block.input) : "";

  const resultText = result ? stringifyContent(result.content) : "";
  const resultIsLong = resultText.length > 240 || resultText.split("\n").length > 6;

  return (
    <div className="agent-tool-generic" data-status={status}>
      <div className="agent-tool-generic-row">
        <span className="agent-tool-generic-name">{block.name}</span>
        <span className="agent-tool-generic-summary" title={summary.text}>
          {summary.text}
        </span>
        <button
          type="button"
          className="agent-tool-generic-input-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Hide tool input" : "Show tool input"}
        >
          {GLYPHS.disclosure} {open ? "hide" : "input"}
        </button>
      </div>
      {open ? (
        <div className="agent-tool-generic-input-body">
          <CodeFence code={inputJson} language="json" />
        </div>
      ) : null}
      {resultText && !resultIsLong ? (
        <div className="agent-tool-generic-result">{resultText}</div>
      ) : null}
      {resultText && resultIsLong ? (
        <details className="agent-tool-generic-result-details">
          <summary className="agent-tool-generic-result-summary">
            {GLYPHS.disclosure} result · {resultText.split("\n").length} lines
          </summary>
          <div className="agent-tool-generic-result-body">
            <CodeFence code={resultText} language={detectLanguage(resultText)} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function stringifyContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
        return (b as { text: string }).text;
      }
      return prettyJson(b);
    })
    .join("\n");
}

/** Heuristic language pick for the result body — JSON shape gets
 *  highlight, otherwise plain. */
function detectLanguage(s: string): string {
  const t = s.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  return "";
}
