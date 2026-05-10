import { useMemo } from "react";
import { CodeFence } from "./CodeFence";

interface SmartOutputProps {
  text: string;
  /** Optional language hint (e.g. file extension on Read).  When given,
   *  forces syntax highlighting in that language regardless of detection. */
  languageHint?: string | null;
  /** ClassName for the fallback <pre> when no smart treatment applies.
   *  Defaults to a generic agent-tool-output class. */
  className?: string;
  /**
   * Whether the output is final (i.e. the parent tool has emitted its result)
   * or still streaming.  AGENT-13: while streaming, skip the JSON.parse +
   * JSON.stringify round-trip — it's quadratic over the chunks since we'd
   * re-parse the whole growing buffer per delta. We render plain text mid-stream
   * and switch to the JSON-pretty rendering only when `isFinal === true`.
   * Defaults to `true` for backward compatibility — most call sites already
   * pass a finalized string.
   */
  isFinal?: boolean;
}

/**
 * "Smart" rendering for tool output (Bash stdout, Read file content, etc.).
 *
 *   - ANSI escape codes (\x1b[…m, \x1b]…\x07, OSC, etc.) are stripped so
 *     terminal-coloured output doesn't show up as `[33mfoo[0m` literals.
 *   - If a `languageHint` is provided (e.g. "ts" from a Read tool's path),
 *     the body is rendered as a highlighted CodeFence in that language.
 *   - If no hint and the body parses as JSON, it's pretty-printed and
 *     highlighted as JSON.
 *   - Otherwise the body is rendered as a plain <pre> (preserves layout
 *     of CLI table output, ASCII art, etc.).
 *
 * Pure component — no IO, no animation, no streaming hooks.  Cheap enough
 * to call inline from any tool-block renderer.
 */
export function SmartOutput({
  text,
  languageHint,
  className,
  isFinal = true,
}: SmartOutputProps) {
  const cleaned = useMemo(() => stripAnsi(text), [text]);

  const detection = useMemo(() => {
    if (languageHint) {
      return { kind: "code" as const, language: languageHint, body: cleaned };
    }
    // AGENT-13: only attempt JSON parsing when the tool has finalized.
    // Streaming chunks of a JSON-shaped output would otherwise cost O(L)
    // per delta (parse + stringify the whole buffer) → O(L²) over the turn.
    if (isFinal) {
      const json = tryParseJson(cleaned);
      if (json !== undefined) {
        return { kind: "code" as const, language: "json", body: json };
      }
    }
    return { kind: "text" as const, body: cleaned };
  }, [cleaned, languageHint, isFinal]);

  if (detection.kind === "code") {
    return <CodeFence code={detection.body} language={detection.language} />;
  }
  return <pre className={className ?? "agent-tool-output"}>{detection.body}</pre>;
}

/**
 * Strip ANSI escape sequences.  Covers the two common families that show up
 * in CLI output: CSI (ESC `[` … letter) and OSC (ESC `]` … BEL).  Both are
 * matched as one alternation; using two simpler patterns avoids the
 * mis-matched-paren foot-gun of chalk's full ansi-regex.
 *
 * The patterns intentionally stop at the terminating letter / BEL so we
 * never gobble surrounding output.  No need for the `u` flag — every code
 * unit we match is in the BMP.
 */
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "").replace(ANSI_OSC, "");
}

/**
 * If `text` is parseable as JSON and its value is non-trivial (not just a
 * number/string), return the pretty-printed version.  Otherwise return
 * `undefined` so the caller falls through to plain text.
 *
 * The heuristic is conservative: we require the trimmed text to start with
 * `{` or `[` so we don't aggressively reformat single-line numeric output
 * like `42` or `"ok"` (which technically parse as JSON but aren't useful
 * to pretty-print).
 */
export function tryParseJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return undefined;
  }
}
