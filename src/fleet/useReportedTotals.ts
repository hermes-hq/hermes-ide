// Totals of the sessions' usage (F31): the status bar's spend and token
// count with the `fleetControls` flag on. They come from the same usage
// snapshots the session rows, the project headers and the Context panel
// read, so every surface agrees. A part nobody reported is null, and the
// status bar leaves it out; a total with an estimate in it is "estimated".

import { useEffect, useState } from "react";
import { getSessionEventSnapshot, subscribeSessionEvents } from "../agent/contract/sessionEventStore";
import { sumReported, totalSpend, type SpendKind } from "./spend";

export interface ReportedTotals {
  readonly costUsd: number | null;
  /** How the cost was arrived at ("na" when there is none). */
  readonly spend: SpendKind;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export function reportedTotals(sessionIds: readonly string[]): ReportedTotals {
  const usages = sessionIds.map((id) => getSessionEventSnapshot(id).usage);
  const spend = totalSpend(usages);
  return {
    costUsd: spend.costUsd,
    spend: spend.kind,
    inputTokens: sumReported(usages.map((u) => u?.inputTokens ?? null)),
    outputTokens: sumReported(usages.map((u) => u?.outputTokens ?? null)),
  };
}

function same(a: ReportedTotals, b: ReportedTotals): boolean {
  return a.costUsd === b.costUsd && a.spend === b.spend && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens;
}

export function useReportedTotals(sessionIds: readonly string[], enabled = true): ReportedTotals {
  const key = sessionIds.join("\n");
  const [totals, setTotals] = useState<ReportedTotals>(() => reportedTotals(sessionIds));
  useEffect(() => {
    if (!enabled) return;
    const ids = key ? key.split("\n") : [];
    const update = () => {
      const next = reportedTotals(ids);
      setTotals((prev) => (same(prev, next) ? prev : next));
    };
    update();
    const offs = ids.map((id) => subscribeSessionEvents(id, update));
    return () => {
      for (const off of offs) off();
    };
  }, [key, enabled]);
  return totals;
}
