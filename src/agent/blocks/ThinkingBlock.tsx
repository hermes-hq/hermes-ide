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

  // Live-update the elapsed counter while we're streaming.
  // Once `elapsedMs` is provided, the reducer has frozen the value; stop ticking.
  //
  // AGENT-20: tick at 100ms only while elapsed < 10s (formatter shows tenths
  // there); after that, drop to 1Hz since the formatter only renders integer
  // seconds. With many simultaneous thinking blocks (sub-agents, forks),
  // this avoids 10× redundant re-renders per block per second.
  const live = startedAt !== undefined && elapsedMs === undefined;
  useEffect(() => {
    if (!live || startedAt === undefined) return;
    let cancelled = false;
    const FAST_TICK_MS = 100;
    const SLOW_TICK_MS = 1000;
    const FAST_PHASE_MS = 10_000;

    const schedule = (ms: number) => {
      if (cancelled) return;
      timer = setTimeout(() => {
        if (cancelled) return;
        setTick((t) => t + 1);
        const elapsedMs = Date.now() - startedAt;
        schedule(elapsedMs < FAST_PHASE_MS ? FAST_TICK_MS : SLOW_TICK_MS);
      }, ms);
    };

    let timer: ReturnType<typeof setTimeout>;
    const initialElapsed = Date.now() - startedAt;
    schedule(initialElapsed < FAST_PHASE_MS ? FAST_TICK_MS : SLOW_TICK_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer!);
    };
  }, [live, startedAt]);

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
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  return `${Math.round(s)}s`;
}
