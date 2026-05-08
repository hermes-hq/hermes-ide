import type { ContentBlock, ToolResultBlockData } from "../types";
import { CodeFence } from "./CodeFence";
import { prettyJson } from "../../utils/jsonSummary";

interface ToolResultBlockProps {
  block: ToolResultBlockData;
  /**
   * Render compact (quietly inline) vs. standalone (hairline panel).
   *
   * Standalone is rare — most tool_results are absorbed into the parent tool
   * block (FileToolBlock shows the diff inline, ExecToolBlock shows stdout
   * inline, etc.). Standalone fires only when a tool_result arrives without a
   * matching tool_use visible (mid-stream reconnect, etc.).
   */
  compact?: boolean;
}

/**
 * Standalone-or-inline renderer for `tool_result` blocks.  Plain-text
 * content renders inline.  Structured (non-text) content falls through
 * a syntax-highlighted JSON code fence rather than dumping as raw
 * `<pre>` JSON, so reconnect-time orphan results don't blow out the
 * column width with a wall of stringified blocks.
 */
export function ToolResultBlock({ block, compact = false }: ToolResultBlockProps) {
  const { plain, structured } = partitionContent(block.content);
  const cls =
    "agent-tool-result" +
    (block.is_error ? " is-error" : "") +
    (compact ? " compact" : "");

  return (
    <div className={cls}>
      {plain && <pre className="agent-tool-result-body">{plain}</pre>}
      {structured.length > 0 && (
        <div className="agent-tool-result-structured">
          <CodeFence code={prettyJson(structured)} language="json" />
        </div>
      )}
    </div>
  );
}

/** Split a tool-result content array into the readable text portion
 *  and the structured (non-text) tail.  The text portion concatenates
 *  cleanly; the structured tail renders as JSON. */
function partitionContent(
  content: string | ContentBlock[],
): { plain: string; structured: ContentBlock[] } {
  if (typeof content === "string") return { plain: content, structured: [] };
  if (!Array.isArray(content)) return { plain: "", structured: [] };
  const textParts: string[] = [];
  const structured: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
      textParts.push((b as { text: string }).text);
    } else {
      structured.push(b);
    }
  }
  return { plain: textParts.join("\n"), structured };
}
