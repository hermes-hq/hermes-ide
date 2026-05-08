import type { ContentBlock, ToolResultBlockData } from "../types";

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
 * Standalone-or-inline renderer for `tool_result` blocks. See playbook §5
 * ToolResultBlock.
 *
 * Quiet inline appearance: text in `--ink-secondary`, no card. If the result
 * is an error, a `--tool-error` left bar marks it. Standalone uses a
 * hairline-bordered panel, family-neutral.
 */
export function ToolResultBlock({ block, compact = false }: ToolResultBlockProps) {
  const text = stringifyContent(block.content);
  const cls =
    "agent-tool-result" +
    (block.is_error ? " is-error" : "") +
    (compact ? " compact" : "");
  return (
    <div className={cls}>
      <pre className="agent-tool-result-body">{text}</pre>
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
      try {
        return JSON.stringify(b, null, 2);
      } catch {
        return String(b);
      }
    })
    .join("\n");
}
