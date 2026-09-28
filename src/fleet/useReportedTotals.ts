// Totals of what the agents themselves reported (F31): the status bar's
// spend and token count with the `fleetControls` flag on. A part no agent
// reported is null, and the status bar leaves it out.

import { useEffect, useState } from "react";
import { getSessionEventSnapshot, subscribeSessionEvents } from "../agent/contract/sessionEventStore";
import { sumReported } from "./spend";

export interface ReportedTotals {
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export function reportedTotals(sessionIds: readonly string[]): ReportedTotals {
  const usages = sessionIds.map((id) => getSessionEventSnapshot(id).usage);
  return {
    costUsd: sumReported(usages.map((u) => u?.costUsd ?? null)),
    inputTokens: sumReported(usages.map((u) => u?.inputTokens ?? null)),
    outputTokens: sumReported(usages.map((u) => u?.outputTokens ?? null)),
  };
}

function same(a: ReportedTotals, b: ReportedTotals): boolean {
  return a.costUsd === b.costUsd && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens;
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
