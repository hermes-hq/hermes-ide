import { useEffect, useState } from "react";
import type { ThinkingBlockData } from "../types";

interface ThinkingBlockProps {
  block: ThinkingBlockData;
  defaultOpen?: boolean;
  /**
   * Frozen elapsed ms (set by the reducer once the thinking block has ended).
   * When provided, the elapsed counter renders this value verbatim.
   */
  elapsedMs?: number;
  /**
   * Live ticker base (set by the reducer the first time this thinking block
   * was observed). When provided *and* `elapsedMs` is undefined, the component
   * runs a 10Hz interval to render `Date.now() - startedAt`.
   */
  startedAt?: number;
}

/** Collapsible thinking block. Collapsed by default. */
export function ThinkingBlock({
  block,
  defaultOpen = false,
  elapsedMs,
  startedAt,
}: ThinkingBlockProps) {
  const [open, setOpen] = useState(defaultOpen);
  // `tick` exists only to force re-renders during the live phase. We compute
  // the displayed value from `Date.now() - startedAt` directly so the value
  // stays current even if React batches.
  const [, setTick] = useState(0);

  // Live-update the elapsed counter at 10Hz while we're streaming.
  // Once `elapsedMs` is provided, the reducer has frozen the value; stop ticking.
  const live = startedAt !== undefined && elapsedMs === undefined;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [live]);

  const elapsed =
    elapsedMs !== undefined
      ? elapsedMs
      : startedAt !== undefined
      ? Math.max(0, Date.now() - startedAt)
      : null;

  const elapsedLabel = elapsed !== null ? formatElapsedSeconds(elapsed) : null;

  return (
    <div className={`agent-thinking-block${open ? " open" : ""}`}>
      <button
        type="button"
        className="agent-thinking-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="agent-thinking-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="agent-thinking-label">
          {live ? "thinking" : "thought"}
        </span>
        {elapsedLabel !== null ? (
          <span className="agent-thinking-elapsed">{elapsedLabel}</span>
        ) : null}
      </button>
      {open ? (
        <pre className="agent-thinking-body">{block.thinking}</pre>
      ) : null}
    </div>
  );
}

/**
 * Format an elapsed milliseconds value as a compact mono-number string.
 * Mirrors the playbook §6 spec:
 *   < 10s → one decimal place ("0.4s", "8.5s")
 *   ≥ 10s → integer seconds ("24s")
 */
export function formatElapsedSeconds(ms: number): string {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}
