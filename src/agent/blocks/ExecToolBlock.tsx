import { useState } from "react";
import type { ContentBlock, ToolResultBlockData, ToolUseBlockData } from "../types";
import { GLYPHS } from "./glyphs";
import { SmartOutput } from "./SmartOutput";

interface ExecToolBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

const TAIL_LINES = 4;
const COLLAPSE_THRESHOLD = 12;

/**
 * Renderer for the **exec** family: Bash, Run.
 *
 * Visual: NO card. 2px left bar (yellow while running, green on success, red
 * on error) + `▸ command` + indented output. See playbook §5.
 *
 * The `data-status` attribute is `running` (no result yet), `success` (result
 * present and not an error), or `error` (result present and is_error). Phase 5
 * will animate the running bar via the respiration keyframes — for now it just
 * uses the static yellow.
 *
 * Long output (> {@link COLLAPSE_THRESHOLD} lines) collapses to the last
 * {@link TAIL_LINES} lines plus a `▾ N hidden lines` disclosure.
 */
export function ExecToolBlock({ block, result }: ExecToolBlockProps) {
  const command = stringValue(block.input, ["command", "cmd"]) ?? "";
  const status = !result ? "running" : result.is_error ? "error" : "success";
  const output = result ? stringifyContent(result.content) : "";
  const exitCode = numberValue(block.input.exit_code);

  const allLines = output === "" ? [] : output.split("\n");
  const isLong = allLines.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(!isLong);

  const visible = expanded ? allLines : allLines.slice(-TAIL_LINES);
  const hiddenCount = isLong && !expanded ? allLines.length - TAIL_LINES : 0;
  const visibleText = visible.join("\n");

  return (
    <div className="agent-tool-exec" data-status={status}>
      <div className="agent-tool-exec-bar" aria-hidden="true" />
      <div className="agent-tool-exec-body">
        <div className="agent-tool-exec-command">
          <span className="agent-tool-exec-glyph" aria-hidden="true">
            {GLYPHS.exec}
          </span>
          <code>{command}</code>
          {exitCode !== undefined && exitCode !== 0 ? (
            <span className="agent-tool-exec-exit"> · exit {exitCode}</span>
          ) : null}
        </div>
        {output ? (
          <>
            {hiddenCount > 0 ? (
              <button
                type="button"
                className="agent-tool-exec-disclosure"
                onClick={() => setExpanded(true)}
                aria-expanded="false"
              >
                {GLYPHS.disclosure} {hiddenCount} hidden lines
              </button>
            ) : null}
            <SmartOutput text={visibleText} className="agent-tool-exec-output" />
          </>
        ) : null}
      </div>
    </div>
  );
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

function numberValue(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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
