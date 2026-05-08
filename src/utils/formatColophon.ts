/**
 * Pure formatters for the agent-mode end-of-turn colophon.
 *
 * The colophon is a quiet, right-aligned three-number summary that follows
 * the last assistant message of a turn:
 *
 *     8.5s · 303 out · $0.13
 *
 * These helpers are kept pure (no React, no DOM) so they can be unit-tested
 * cheaply and reused by any future end-of-turn surface.
 */

/**
 * Format a duration in milliseconds to a compact human-readable string.
 *
 * - `< 10_000`        → one decimal seconds, e.g. `"0.4s"`, `"8.5s"`
 * - `>= 10_000`, `< 60_000` → integer seconds, e.g. `"23s"`
 * - `>= 60_000`, `< 3_600_000` → `"Xm Ys"`, e.g. `"1m 30s"`
 * - `>= 3_600_000`    → `"Xh Ym Zs"`, e.g. `"1h 0m 0s"`
 * - `undefined` / `0` → `""` (caller should omit segment)
 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${h}h ${m}m ${s}s`;
}

/**
 * Format an output-token count with `k`/`M` suffixes.
 *
 * - `< 1_000`         → bare integer, e.g. `"303"`
 * - `< 1_000_000`     → one decimal `k`, e.g. `"1.2k"`
 * - `>= 1_000_000`    → one decimal `M`, e.g. `"1.2M"`
 * - `undefined`       → `""` (caller should omit segment)
 *
 * Note: zero is rendered as `"0"`. Callers that wish to hide a zero-token
 * segment should special-case the value at the call site.
 */
export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format a USD cost.
 *
 * Always 2 decimals, e.g. `"$0.13"`, `"$12.35"`. Zero is rendered as `"$0.00"`
 * (still meaningful — e.g. cached requests). `undefined` → `""`.
 */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return "";
  return `$${usd.toFixed(2)}`;
}

/**
 * Compose the colophon string: `duration · output_tokens · cost`, joined with
 * `" · "`. Segments that resolve to an empty string are omitted; if all three
 * are empty, returns `""` so the caller can hide the colophon entirely.
 *
 * Token count is suffixed with `" out"` to disambiguate from input tokens.
 */
export function formatColophon(result: {
  duration_ms?: number;
  usage?: { output_tokens?: number; [k: string]: unknown };
  total_cost_usd?: number;
}): string {
  const parts: string[] = [];

  const d = formatDuration(result.duration_ms);
  if (d) parts.push(d);

  const t = formatTokens(result.usage?.output_tokens);
  if (t) parts.push(`${t} out`);

  const c = formatCost(result.total_cost_usd);
  if (c) parts.push(c);

  return parts.join(" · ");
}
