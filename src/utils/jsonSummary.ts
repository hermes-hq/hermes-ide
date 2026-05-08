/**
 * Micro-summary helpers for tool input / unknown content payloads.
 *
 * The agent timeline used to dump pretty-printed JSON inside an
 * unbounded `<pre>` whenever a tool's input didn't match a known
 * family (GenericToolBlock) or when a tool_result contained nested
 * non-text blocks (ToolResultBlock fallback).  On a long config or
 * deeply-nested structure that produced a wall of unstyled JSON,
 * blowing out the column width.
 *
 * The replacement is a one-line summary that hints at the shape +
 * size, plus a `<details>` disclosure that reveals the full payload
 * inside a syntax-highlighted, scrollable, max-height-capped code
 * block.  The summary lives next to the tool name; the disclosure is
 * one click away.
 *
 * The summary intentionally avoids JSON-stringify on big inputs — it
 * only inspects keys / lengths so the cost is O(n) shallow.
 */

const COMMAND_HINT_KEYS = ["command", "cmd", "shell"] as const;
const PATH_HINT_KEYS = ["file_path", "path", "filePath", "file"] as const;
const PATTERN_HINT_KEYS = ["pattern", "query", "search"] as const;
const URL_HINT_KEYS = ["url", "endpoint"] as const;

export interface JsonSummary {
  /** Human-readable one-liner suitable for inline display. */
  text: string;
  /** Approximate serialized size in bytes (UTF-8). */
  bytes: number;
}

export function summarizeJsonInput(input: unknown): JsonSummary {
  // Primitives — render the value itself, modestly truncated.
  if (input === null || input === undefined) {
    return { text: "(empty)", bytes: 0 };
  }
  if (typeof input === "string") {
    return {
      text: input.length === 0 ? "(empty string)" : `"${truncate(input, 64)}"`,
      bytes: byteLength(input),
    };
  }
  if (typeof input === "number" || typeof input === "boolean") {
    const s = String(input);
    return { text: s, bytes: s.length };
  }

  if (Array.isArray(input)) {
    if (input.length === 0) return { text: "[ ] (empty array)", bytes: 2 };
    const bytes = byteLengthOfJsonStringify(input);
    return {
      text: `[${input.length} ${input.length === 1 ? "item" : "items"}] · ${formatBytes(bytes)}`,
      bytes,
    };
  }

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return { text: "{ } (empty object)", bytes: 2 };
    const bytes = byteLengthOfJsonStringify(obj);

    // Common shapes: surface the most informative key inline.
    const cmdKey = COMMAND_HINT_KEYS.find((k) => typeof obj[k] === "string");
    if (cmdKey) {
      return {
        text: `${cmdKey}: ${truncate(String(obj[cmdKey]), 60)}`,
        bytes,
      };
    }
    const pathKey = PATH_HINT_KEYS.find((k) => typeof obj[k] === "string");
    if (pathKey) {
      return {
        text: `${truncate(String(obj[pathKey]), 64)}`,
        bytes,
      };
    }
    const patKey = PATTERN_HINT_KEYS.find((k) => typeof obj[k] === "string");
    if (patKey) {
      return {
        text: `${patKey}: ${truncate(String(obj[patKey]), 60)}`,
        bytes,
      };
    }
    const urlKey = URL_HINT_KEYS.find((k) => typeof obj[k] === "string");
    if (urlKey) {
      return {
        text: `${truncate(String(obj[urlKey]), 64)}`,
        bytes,
      };
    }

    // Generic fallback — key count + size.
    return {
      text: `${keys.length} ${keys.length === 1 ? "key" : "keys"} · ${formatBytes(bytes)}`,
      bytes,
    };
  }

  // Catch-all (functions, symbols, BigInt — vanishingly rare on
  // tool inputs, but we mustn't throw).
  const s = String(input);
  return { text: s, bytes: s.length };
}

/** Pretty-printed JSON for the disclosure body.  Falls back gracefully
 *  on circular references (which don't normally occur in tool input
 *  but are not impossible — e.g. observation artifacts of a buggy SDK
 *  shim). */
export function prettyJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function byteLength(s: string): number {
  // Approximate — Unicode-safe count via TextEncoder is exact, but
  // we're only sizing for human-readable hints, so length is fine
  // for ASCII-heavy code.  Use TextEncoder when available for
  // accuracy with multibyte content.
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s).length;
  }
  return s.length;
}

function byteLengthOfJsonStringify(v: unknown): number {
  try {
    return byteLength(JSON.stringify(v));
  } catch {
    return 0;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 100) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
