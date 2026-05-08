import { useState } from "react";
import type { ContentBlock, ToolResultBlockData, ToolUseBlockData } from "../types";
import { GLYPHS } from "./glyphs";

interface WebToolBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

const EXCERPT_LIMIT = 200;

/**
 * Renderer for the **web** family: WebFetch, WebSearch.
 *
 * **The only place serif appears in the entire agent UI.** The citation
 * header is monospace (URL/path); the excerpt body is `var(--font-serif)`
 * (Newsreader). See playbook §3 + §5.
 *
 * The serif's preciousness comes from its scarcity — protect it. Don't
 * render serif anywhere else.
 */
export function WebToolBlock({ block, result }: WebToolBlockProps) {
  const url = stringValue(block.input, ["url", "link"]) ?? "";
  const queryFallback = stringValue(block.input, ["query", "q"]) ?? "";
  const status = !result ? "running" : result.is_error ? "error" : "success";

  const excerpt = result ? stringifyContent(result.content) : "";
  const truncated = truncateAtSentence(excerpt, EXCERPT_LIMIT);
  const isTruncated = excerpt.length > truncated.length;
  const [expanded, setExpanded] = useState(false);
  const display = expanded ? excerpt : truncated;

  return (
    <div className="agent-tool-web" data-status={status}>
      <div className="agent-tool-web-citation">
        <sup className="agent-tool-web-glyph" aria-hidden="true">
          {GLYPHS.citation}
        </sup>
        <span className="agent-tool-web-url">{url || queryFallback}</span>
      </div>
      {display ? (
        <div className="agent-tool-web-excerpt">{display}</div>
      ) : null}
      {isTruncated && !expanded ? (
        <button
          type="button"
          className="agent-tool-web-disclosure"
          onClick={() => setExpanded(true)}
          aria-expanded="false"
        >
          … Read full
        </button>
      ) : null}
    </div>
  );
}

function truncateAtSentence(s: string, limit: number): string {
  if (s.length <= limit) return s;
  const slice = s.slice(0, limit);
  // Prefer cutting at the last sentence boundary inside the slice.
  const lastSentence = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  if (lastSentence > limit * 0.5) return slice.slice(0, lastSentence + 1);
  // Otherwise cut at the last word boundary.
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace > limit * 0.5) return slice.slice(0, lastSpace);
  return slice;
}

function stringValue(
  input: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function stringifyContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
        return (b as { text: string }).text;
      }
      try {
        return JSON.stringify(b, null, 2);
      } catch {
        return String(b);
      }
    })
    .join("\n");
}
