import { useState } from "react";
import type { ResultEvent } from "../types";
import {
  formatColophon,
  formatCost,
  formatDuration,
  formatTokens,
} from "../../utils/formatColophon";

interface ResultFooterProps {
  result: ResultEvent;
}

interface UsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

/**
 * End-of-turn colophon. Quiet, right-aligned three-number summary:
 *
 *     8.5s · 303 out · $0.13
 *
 * Click the summary to expand an inline detail panel with the full data.
 */
export function ResultFooter({ result }: ResultFooterProps) {
  const [open, setOpen] = useState(false);

  const usage = result.usage as UsageShape | undefined;

  const colophon = formatColophon({
    duration_ms: result.duration_ms,
    usage,
    total_cost_usd: result.total_cost_usd,
  });

  if (!colophon) return null;

  return (
    <div className={`agent-colophon${open ? " agent-colophon-open" : ""}`}>
      <button
        type="button"
        className="agent-colophon-summary"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {colophon}
      </button>
      {open ? <ColophonDetails result={result} usage={usage} /> : null}
    </div>
  );
}

interface ColophonDetailsProps {
  result: ResultEvent;
  usage: UsageShape | undefined;
}

/**
 * Two-column key/value detail panel. Keys in `--ink-tertiary`, values in
 * `--ink-secondary`. Tabular-nums applied via the parent CSS rule.
 */
function ColophonDetails({ result, usage }: ColophonDetailsProps) {
  const rows: { key: string; value: string }[] = [];

  // model: usually only present on AssistantEvent, but ResultEvent sometimes
  // carries it through `modelUsage` keys; we surface the bare model name when
  // available.
  const modelName = pickModelName(result);
  if (modelName) rows.push({ key: "model", value: modelName });

  if (result.stop_reason) {
    rows.push({ key: "stop reason", value: result.stop_reason });
  }

  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWritten = usage?.cache_creation_input_tokens ?? 0;
  if (cacheRead > 0 || cacheWritten > 0) {
    rows.push({
      key: "cache",
      value: `read ${formatTokens(cacheRead)} · written ${formatTokens(cacheWritten)}`,
    });
  }

  const inTok = usage?.input_tokens;
  const outTok = usage?.output_tokens;
  if (inTok !== undefined || outTok !== undefined) {
    rows.push({
      key: "tokens",
      value: `${formatTokens(inTok ?? 0)} in · ${formatTokens(outTok ?? 0)} out`,
    });
  }

  if (typeof result.duration_ms === "number") {
    const wall = formatDuration(result.duration_ms);
    const api =
      typeof result.duration_api_ms === "number"
        ? formatDuration(result.duration_api_ms)
        : "";
    rows.push({
      key: "duration",
      value: api ? `${wall} (api ${api})` : wall,
    });
  }

  if (typeof result.total_cost_usd === "number") {
    rows.push({ key: "cost", value: formatCost(result.total_cost_usd) });
  }

  return (
    <dl className="agent-colophon-details">
      {rows.map((row) => (
        <RowFragment key={row.key} dt={row.key} dd={row.value} />
      ))}
    </dl>
  );
}

function RowFragment({ dt, dd }: { dt: string; dd: string }) {
  return (
    <>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </>
  );
}

function pickModelName(result: ResultEvent): string | undefined {
  const direct = (result as { model?: unknown }).model;
  if (typeof direct === "string" && direct.length > 0) return direct;

  const modelUsage = result.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    const keys = Object.keys(modelUsage);
    if (keys.length > 0) return keys[0];
  }
  return undefined;
}
