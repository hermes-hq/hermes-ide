import type { ReactElement } from "react";
import { useState } from "react";
import type { ContentBlock, ToolResultBlockData, ToolUseBlockData } from "../types";
import { GLYPHS } from "./glyphs";
import { UnifiedDiff } from "./UnifiedDiff";
import { computeDiff } from "../../utils/unifiedDiff";
import { SmartOutput } from "./SmartOutput";

interface FileToolBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

/**
 * Renderer for the **file** family: Read, Write, Edit, NotebookEdit.
 *
 * Visual: card with a 3px violet top stripe (--tool-file), `◇` glyph in the
 * header, line-number gutter on the body. See playbook §5.
 *
 * For Edit/Write the body currently shows the input contents stacked
 * (before/after for Edit, full content for Write). Phase 4 will swap in the
 * real `<UnifiedDiff>`. The `block` and `result` props are the slot the diff
 * component will pull `oldStr` / `newStr` / `filePath` from.
 *
 * Default-collapsed when content > 8 lines, with `▾ Show N more lines`.
 */
export function FileToolBlock({ block, result }: FileToolBlockProps) {
  const filePath =
    stringValue(block.input, ["file_path", "path", "notebook_path"]) ?? "";
  const status = !result ? "running" : result.is_error ? "error" : "success";

  const variant = pickVariant(block.name);
  const summary = computeSummary(variant, block.input);

  const body = renderBody(variant, block, result, filePath);
  const longContent = body.lineCount > 8;
  const [expanded, setExpanded] = useState(!longContent);

  return (
    <div className="agent-tool-file" data-status={status}>
      <div className="agent-tool-file-header">
        <span className="agent-tool-file-glyph" aria-hidden="true">
          {GLYPHS.file}
        </span>
        <span className="agent-tool-file-path">{filePath || block.name}</span>
        {summary ? (
          <span className="agent-tool-file-summary">{summary}</span>
        ) : null}
      </div>
      {expanded ? (
        body.element
      ) : (
        <button
          type="button"
          className="agent-tool-file-disclosure"
          onClick={() => setExpanded(true)}
          aria-expanded="false"
        >
          {GLYPHS.disclosure} Show {body.lineCount} more lines
        </button>
      )}
    </div>
  );
}

type FileVariant = "read" | "write" | "edit" | "notebookedit";

function pickVariant(toolName: string): FileVariant {
  const k = toolName.toLowerCase().replace(/[\s_-]/g, "");
  if (k === "read") return "read";
  if (k === "write") return "write";
  if (k === "notebookedit") return "notebookedit";
  return "edit";
}

function computeSummary(
  variant: FileVariant,
  input: Record<string, unknown>,
): string | null {
  if (variant === "edit") {
    const oldStr = stringValue(input, ["old_string"]) ?? "";
    const newStr = stringValue(input, ["new_string"]) ?? "";
    const removed = countLines(oldStr);
    const added = countLines(newStr);
    return `+${added}, −${removed}`;
  }
  if (variant === "write") {
    const content = stringValue(input, ["content", "text"]) ?? "";
    const added = countLines(content);
    return `+${added}, −0`;
  }
  if (variant === "read") {
    const offset = numberValue(input.offset);
    const limit = numberValue(input.limit);
    if (offset !== undefined && limit !== undefined) {
      return `lines ${offset}–${offset + limit - 1}`;
    }
    if (limit !== undefined) return `lines 1–${limit}`;
    if (offset !== undefined) return `from line ${offset}`;
    return null;
  }
  return null;
}

interface RenderedBody {
  element: ReactElement;
  lineCount: number;
}

function renderBody(
  variant: FileVariant,
  block: ToolUseBlockData,
  result: ToolResultBlockData | undefined,
  filePath: string,
): RenderedBody {
  // Phase 4 (v1.0.0 redesign): Edit / Write / NotebookEdit render through the
  // hand-rolled `<UnifiedDiff>` component (playbook §5 UnifiedDiffBlock).
  // Read keeps the line-numbered file-content treatment.
  if (variant === "edit") {
    const oldStr = stringValue(block.input, ["old_string"]) ?? "";
    const newStr = stringValue(block.input, ["new_string"]) ?? "";
    return diffBody(oldStr, newStr, filePath);
  }
  if (variant === "write") {
    const content = stringValue(block.input, ["content", "text"]) ?? "";
    // Full-file writes diff against an empty `before` so every line appears
    // as an addition — that's the user's intuition for "I just wrote this".
    return diffBody("", content, filePath);
  }
  if (variant === "notebookedit") {
    const oldSrc = stringValue(block.input, ["old_source", "old_string"]) ?? "";
    const newSrc = stringValue(block.input, ["new_source", "new_string"]) ?? "";
    return diffBody(oldSrc, newSrc, filePath);
  }
  // Read: body is the file content from the result.  We hand it off to
  // SmartOutput with a language hint derived from the file extension so the
  // contents get proper syntax highlighting.  Claude's Read tool already
  // prepends `  N→` line markers, so we don't need to draw a separate gutter.
  const text = result ? stringifyContent(result.content) : "";
  return readBody(text, filePath);
}

function readBody(content: string, filePath: string): RenderedBody {
  const language = languageFromPath(filePath);
  const lineCount = content === "" ? 0 : content.split("\n").length;
  const element = (
    <div className="agent-tool-file-body agent-tool-file-body-read">
      <SmartOutput text={content} languageHint={language} />
    </div>
  );
  return { element, lineCount };
}

/** Map a file path's extension to a highlight.js language id (or null when
 *  unrecognized — SmartOutput then falls back to auto-detection). */
function languageFromPath(filePath: string): string | null {
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  switch (ext) {
    case "ts": case "tsx": return "typescript";
    case "js": case "jsx": case "mjs": case "cjs": return "javascript";
    case "rs": return "rust";
    case "py": return "python";
    case "rb": return "ruby";
    case "go": return "go";
    case "java": return "java";
    case "kt": case "kts": return "kotlin";
    case "swift": return "swift";
    case "c": case "h": return "c";
    case "cpp": case "cc": case "hpp": case "cxx": return "cpp";
    case "cs": return "csharp";
    case "php": return "php";
    case "sh": case "bash": case "zsh": return "bash";
    case "json": return "json";
    case "yaml": case "yml": return "yaml";
    case "toml": return "ini";
    case "css": return "css";
    case "scss": case "sass": return "scss";
    case "html": case "htm": return "html";
    case "xml": case "svg": return "xml";
    case "md": case "markdown": return "markdown";
    case "sql": return "sql";
    case "lua": return "lua";
    case "pl": return "perl";
    case "r": return "r";
    case "ex": case "exs": return "elixir";
    case "clj": case "cljs": return "clojure";
    case "scala": return "scala";
    case "dart": return "dart";
    default: return null;
  }
}

function diffBody(before: string, after: string, filePath: string): RenderedBody {
  const diff = computeDiff(before, after);
  // For collapse semantics we count rows the renderer will actually emit.
  // `skip` rows count as 1 (a `…` separator), which matches what the user sees.
  const lineCount = diff.truncated ? 1 : diff.lines.length;
  const element = (
    <div className="agent-tool-file-body agent-tool-file-body-diff">
      <UnifiedDiff before={before} after={after} filePath={filePath} />
    </div>
  );
  return { element, lineCount };
}

function countLines(s: string): number {
  if (s === "") return 0;
  return s.split("\n").length;
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
