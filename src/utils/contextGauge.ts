// ─── Context gauge (F14) ──────────────────────────────────────────────
//
// How full a session's context window is, from the agent's own report (the
// `usage` SessionEvent). No report, or a model whose window Hermes does not
// know, means no gauge: never an estimate.

import type { SessionContextUsage } from "../agent/contract/sessionEventStore";

export const CONTEXT_WARN_PERCENT = 80;
export const CONTEXT_CRITICAL_PERCENT = 95;

export interface ContextGaugeView {
  /** Whole percent, 0..100. */
  readonly percent: number;
  readonly usedTokens: number;
  readonly contextLimit: number;
  readonly level: "ok" | "warn" | "critical";
}

export function contextGauge(usage: SessionContextUsage | null): ContextGaugeView | null {
  if (!usage || usage.contextLimit === null || usage.contextLimit <= 0) return null;
  const percent = Math.min(100, Math.max(0, Math.round((usage.usedTokens / usage.contextLimit) * 100)));
  const level = percent >= CONTEXT_CRITICAL_PERCENT ? "critical" : percent >= CONTEXT_WARN_PERCENT ? "warn" : "ok";
  return { percent, usedTokens: usage.usedTokens, contextLimit: usage.contextLimit, level };
}
