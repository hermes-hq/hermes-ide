// ─── Honest spend (F31) ──────────────────────────────────────────────
//
// Hermes shows a cost only when the agent itself reported it, through a
// `usage` SessionEvent (docs/adr/004-2.0-contracts.md). Everything else is
// "n/a": no price tables, no token-times-rate guesses.
//
// A soft cap trips once per scope and cap value: the session (or every
// session of a feature branch) is interrupted and a `limit` inbox item is
// raised. Changing the cap re-arms it; while it keeps its value it never
// trips twice (see spendCapWatcher).

import type { FleetCaps } from "./fleetSettings";

/** "$0.42", "<$0.01" for a cost under a cent, "$0.00" for nothing spent. */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/** A cost the agent reported, or null ("n/a"). */
export type ReportedCost = number | null;

/** Sum of the costs that were reported; null when none was. */
export function sumReported(costs: readonly ReportedCost[]): ReportedCost {
  let total: number | null = null;
  for (const c of costs) if (c !== null) total = (total ?? 0) + c;
  return total;
}

export interface FeatureRef {
  /** Stable key: the repository and the branch. */
  readonly key: string;
  /** For people: the branch name. */
  readonly label: string;
}

export type SpendScopeKind = "session" | "feature";

export interface CapTrip {
  readonly kind: SpendScopeKind;
  /** Session id or feature key. */
  readonly key: string;
  /** Session label or branch name. */
  readonly label: string;
  /** Every live session in the scope: all of them are interrupted. */
  readonly sessionIds: readonly string[];
  /** The session that spent the most (where the inbox item points). */
  readonly leadSessionId: string;
  readonly spentUsd: number;
  readonly capUsd: number;
  /** Identifies this crossing: scope + cap value. */
  readonly tripKey: string;
}

export interface SpendSession {
  readonly id: string;
  readonly label: string;
  readonly costUsd: ReportedCost;
  readonly feature: FeatureRef | null;
}

export function tripKeyFor(kind: SpendScopeKind, key: string, capUsd: number): string {
  return `${kind}:${key}:${capUsd}`;
}

/**
 * Pure: the caps that are reached now and have not tripped before.
 * Sessions whose agent reports no cost can never trip a cap (nothing is
 * known about what they spent), and add nothing to a feature's total.
 */
export function evaluateSpendCaps(
  sessions: readonly SpendSession[],
  caps: Pick<FleetCaps, "sessionUsd" | "featureUsd">,
  alreadyTripped: ReadonlySet<string>,
): CapTrip[] {
  const trips: CapTrip[] = [];
  if (caps.sessionUsd !== null) {
    for (const s of sessions) {
      if (s.costUsd === null || s.costUsd < caps.sessionUsd) continue;
      const tripKey = tripKeyFor("session", s.id, caps.sessionUsd);
      if (alreadyTripped.has(tripKey)) continue;
      trips.push({
        kind: "session",
        key: s.id,
        label: s.label,
        sessionIds: [s.id],
        leadSessionId: s.id,
        spentUsd: s.costUsd,
        capUsd: caps.sessionUsd,
        tripKey,
      });
    }
  }
  if (caps.featureUsd !== null) {
    const byFeature = new Map<string, { ref: FeatureRef; members: SpendSession[] }>();
    for (const s of sessions) {
      if (!s.feature) continue;
      const entry = byFeature.get(s.feature.key) ?? { ref: s.feature, members: [] };
      entry.members.push(s);
      byFeature.set(s.feature.key, entry);
    }
    for (const { ref, members } of byFeature.values()) {
      const spent = sumReported(members.map((m) => m.costUsd));
      if (spent === null || spent < caps.featureUsd) continue;
      const tripKey = tripKeyFor("feature", ref.key, caps.featureUsd);
      if (alreadyTripped.has(tripKey)) continue;
      const lead = [...members].sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1))[0];
      trips.push({
        kind: "feature",
        key: ref.key,
        label: ref.label,
        sessionIds: members.map((m) => m.id),
        leadSessionId: lead.id,
        spentUsd: spent,
        capUsd: caps.featureUsd,
        tripKey,
      });
    }
  }
  return trips;
}
