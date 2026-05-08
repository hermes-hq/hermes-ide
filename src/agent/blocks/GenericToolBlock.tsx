import { useState } from "react";
import type { ContentBlock, ToolResultBlockData, ToolUseBlockData } from "../types";
import { GLYPHS } from "./glyphs";

interface GenericToolBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

/**
 * Fallback renderer for tools that don't fit any known family.
 *
 * **Bare-bones on purpose.** Tool name italic mono in `--ink-tertiary`. Input
 * collapsed under a `▾ input` disclosure (JSON pretty-printed). Result
 * rendered as text. No card border, no background, no embellishment. See
 * playbook §5.
 *
 * Stays ugly to motivate adding a proper family-specific treatment when a
 * new tool becomes important.
 */
export function GenericToolBlock({ block, result }: GenericToolBlockProps) {
  const [open, setOpen] = useState(false);
  const status = !result ? "running" : result.is_error ? "error" : "success";

  let inputJson = "";
  try {
    inputJson = JSON.stringify(block.input, null, 2);
  } catch {
    inputJson = String(block.input);
  }
  const resultText = result ? stringifyContent(result.content) : "";

  return (
    <div className="agent-tool-generic" data-status={status}>
      <div className="agent-tool-generic-row">
        <span className="agent-tool-generic-name">{block.name}</span>
        <button
          type="button"
          className="agent-tool-generic-input-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {GLYPHS.disclosure} input
        </button>
      </div>
      {open ? (
        <pre className="agent-tool-generic-input-pre">{inputJson}</pre>
      ) : null}
      {resultText ? (
        <pre className="agent-tool-generic-result">{resultText}</pre>
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
      try {
        return JSON.stringify(b, null, 2);
      } catch {
        return String(b);
      }
    })
    .join("\n");
}
