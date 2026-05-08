import { useState } from "react";
import type { ContentBlock, ToolResultBlockData, ToolUseBlockData } from "../types";
import { GLYPHS } from "./glyphs";

interface SearchToolBlockProps {
  block: ToolUseBlockData;
  result: ToolResultBlockData | undefined;
}

const PREVIEW_COUNT = 5;

interface ParsedMatch {
  path: string;
  line?: number;
  snippet?: string;
}

/**
 * Renderer for the **search** family: Grep, Glob.
 *
 * Visual: NO card. `⌕ "query" — scope` line in italic mono, then up to 5
 * results as `path:line · "snippet"` rows separated by 1px hairlines. See
 * playbook §5.
 *
 * The result content is the raw output of grep/glob. We parse it into
 * structured matches; if parsing fails we fall back to the raw text.
 */
export function SearchToolBlock({ block, result }: SearchToolBlockProps) {
  const query =
    stringValue(block.input, ["pattern", "query", "regex"]) ?? "";
  const scope = stringValue(block.input, ["path", "glob", "include"]);
  const isGlob = block.name.toLowerCase().replace(/[\s_-]/g, "") === "glob";
  const status = !result ? "running" : result.is_error ? "error" : "success";

  const raw = result ? stringifyContent(result.content) : "";
  const matches = raw === "" ? [] : parseResults(raw, isGlob);
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || matches.length <= PREVIEW_COUNT;
  const visible = showAll ? matches : matches.slice(0, PREVIEW_COUNT);
  const hidden = matches.length - visible.length;

  return (
    <div className="agent-tool-search" data-status={status}>
      <div className="agent-tool-search-query">
        <span className="agent-tool-search-glyph" aria-hidden="true">
          {GLYPHS.search}
        </span>
        <em>"{query}"</em>
        {scope ? (
          <span className="agent-tool-search-scope"> — {scope}</span>
        ) : null}
      </div>
      {matches.length > 0 ? (
        <ol className="agent-tool-search-results">
          {visible.map((m, i) => (
            <li key={i} className="agent-tool-search-row">
              <span className="agent-tool-search-path">{m.path}</span>
              {m.line !== undefined ? (
                <>
                  <span className="agent-tool-search-sep">:</span>
                  <span className="agent-tool-search-line">{m.line}</span>
                </>
              ) : null}
              {m.snippet ? (
                <>
                  <span className="agent-tool-search-dot"> · </span>
                  <span
                    className="agent-tool-search-snippet"
                    dangerouslySetInnerHTML={{
                      __html: highlightSnippet(m.snippet, query),
                    }}
                  />
                </>
              ) : null}
            </li>
          ))}
          {hidden > 0 ? (
            <li className="agent-tool-search-more">
              <button
                type="button"
                className="agent-tool-search-disclosure"
                onClick={() => setExpanded(true)}
                aria-expanded="false"
              >
                {GLYPHS.disclosure} {hidden} more matches
              </button>
            </li>
          ) : null}
        </ol>
      ) : raw ? (
        <pre className="agent-tool-search-raw">{raw}</pre>
      ) : null}
    </div>
  );
}

function parseResults(raw: string, isGlob: boolean): ParsedMatch[] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (isGlob) {
    return lines.map((path) => ({ path }));
  }

  // grep -n style: `path:line:snippet`
  const matches: ParsedMatch[] = [];
  for (const line of lines) {
    const parsed = parseGrepLine(line);
    if (parsed) matches.push(parsed);
  }
  return matches;
}

function parseGrepLine(line: string): ParsedMatch | undefined {
  // Match `path:NN:snippet` with NN = line number.
  const m = /^([^:]+):(\d+):(.*)$/.exec(line);
  if (m) {
    return { path: m[1], line: Number(m[2]), snippet: m[3] };
  }
  // Match `path:snippet` (no line number).
  const m2 = /^([^:]+):(.*)$/.exec(line);
  if (m2) {
    return { path: m2[1], snippet: m2[2] };
  }
  return undefined;
}

function highlightSnippet(snippet: string, query: string): string {
  const escaped = escapeHtml(snippet);
  if (!query) return escaped;
  const safe = escapeRegex(query);
  if (!safe) return escaped;
  try {
    const re = new RegExp(safe, "gi");
    return escaped.replace(re, (m) => `<mark>${m}</mark>`);
  } catch {
    return escaped;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
