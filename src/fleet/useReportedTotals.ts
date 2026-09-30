// Totals of the sessions' usage (F31): the status bar's spend and token
// count with the `fleetControls` flag on. They come from the same usage
// snapshots the session rows, the project headers and the Context panel
// read, so every surface agrees. A part nobody reported is null, and the
// status bar leaves it out; a total with an estimate in it is "estimated".
// Every session with an agent (the ones whose row shows a spend) is counted:
// one whose cost is unknown adds nothing to the sum, and is named in
// `unknown` so a partial sum never passes for the total.

import { useEffect, useState } from "react";
import { getSessionEventSnapshot, subscribeSessionEvents } from "../agent/contract/sessionEventStore";
import { spendOf, sumReported, totalSpend, type SpendKind, type SpendTotal } from "./spend";

/** A session as the totals see it. */
export interface SpendMember {
  readonly id: string;
  /** Its name, for the list of sessions whose cost is unknown. */
  readonly label: string;
  /** Started as an agent or recognised as one (its row shows a spend). */
  readonly agent: boolean;
}

export interface ReportedTotals {
  readonly costUsd: number | null;
  /** How the cost was arrived at ("na" when there is none). */
  readonly spend: SpendKind;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** The sessions with an agent whose cost is unknown, by name. */
  readonly unknown: readonly string[];
}

/** A session as the totals see it, from the session list. */
export function spendMember(s: { id: string; label: string; ai_provider?: string | null; detected_agent?: unknown }): SpendMember {
  return { id: s.id, label: s.label, agent: !!s.ai_provider || !!s.detected_agent };
}

export function reportedTotals(members: readonly SpendMember[]): ReportedTotals {
  // The same sessions whose row shows a spend: an agent, or anything that reported usage.
  const counted = members
    .map((m) => ({ m, usage: getSessionEventSnapshot(m.id).usage }))
    .filter(({ m, usage }) => m.agent || !!usage);
  const usages = counted.map((c) => c.usage);
  const spend = totalSpend(usages);
  return {
    costUsd: spend.costUsd,
    spend: spend.kind,
    inputTokens: sumReported(usages.map((u) => u?.inputTokens ?? null)),
    outputTokens: sumReported(usages.map((u) => u?.outputTokens ?? null)),
    unknown: counted.filter((c) => spendOf(c.usage).costUsd === null).map((c) => c.m.label),
  };
}

/** The totals as the spend helpers take them. */
export function totalOf(totals: ReportedTotals): SpendTotal {
  return { kind: totals.spend, costUsd: totals.costUsd, unknown: totals.unknown.length };
}

/**
 * The tooltip of a total: all of its text (a narrow place may cut it short),
 * where the cost comes from, and the sessions whose cost is unknown.
 */
export function spendTotalTitle(text: string, totals: ReportedTotals, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const lines = [text];
  if (totals.costUsd !== null) lines.push(totals.spend === "estimated" ? t("fleet.spendEstimatedTitle") : t("fleet.spendReported"));
  if (totals.unknown.length > 0) {
    lines.push(t("fleet.spendUnknownTitle"));
    for (const label of totals.unknown) lines.push(`  ${label}`);
  }
  return lines.join("\n");
}

function same(a: ReportedTotals, b: ReportedTotals): boolean {
  return (
    a.costUsd === b.costUsd &&
    a.spend === b.spend &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.unknown.length === b.unknown.length &&
    a.unknown.every((l, i) => l === b.unknown[i])
  );
}

export function useReportedTotals(members: readonly SpendMember[], enabled = true): ReportedTotals {
  const key = JSON.stringify(members.map((m) => [m.id, m.label, m.agent]));
  const [totals, setTotals] = useState<ReportedTotals>(() => reportedTotals(members));
  useEffect(() => {
    if (!enabled) return;
    const list: SpendMember[] = (JSON.parse(key) as [string, string, boolean][]).map(([id, label, agent]) => ({ id, label, agent }));
    const update = () => {
      const next = reportedTotals(list);
      setTotals((prev) => (same(prev, next) ? prev : next));
    };
    update();
    const offs = list.map((m) => subscribeSessionEvents(m.id, update));
    return () => {
      for (const off of offs) off();
    };
  }, [key, enabled]);
  return totals;
}
