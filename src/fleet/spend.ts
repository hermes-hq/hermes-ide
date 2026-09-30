// ─── Honest spend (F31) ──────────────────────────────────────────────
//
// Every cost Hermes shows comes from the `usage` SessionEvent
// (docs/adr/004-2.0-contracts.md): the agent's own cost ("$0.42"), or, when
// the agent only wrote token counts to its transcript, Hermes's estimate at
// list prices, always marked as such ("≈$0.42 (estimated)"). Nothing known
// is "n/a". Tokens read off the screen are never priced.
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

/**
 * What one place shows for spend, from the session-event store's usage (the
 * one source every surface reads): "exact" when the agent reported its cost,
 * "estimated" when Hermes priced the tokens in the agent's transcript, "na"
 * when no cost is known.
 */
export type SpendKind = "na" | "exact" | "estimated";

export interface SpendView {
  readonly kind: SpendKind;
  readonly costUsd: number | null;
}

interface UsageLike {
  readonly costUsd: number | null;
  readonly confidence?: "exact" | "estimated";
}

export function spendOf(usage: UsageLike | null | undefined): SpendView {
  if (!usage || usage.costUsd === null) return { kind: "na", costUsd: null };
  return { kind: usage.confidence === "estimated" ? "estimated" : "exact", costUsd: usage.costUsd };
}

/**
 * The sum over sessions whose agent could have a cost (a plain shell is not
 * passed in). A session whose cost is unknown adds nothing to the sum but is
 * counted in `unknown`, so a partial sum is never shown as the total.
 */
export interface SpendTotal extends SpendView {
  /** How many of the sessions have no known cost. */
  readonly unknown: number;
}

/** The sum over sessions; "estimated" as soon as one estimated cost is in it. */
export function totalSpend(usages: readonly (UsageLike | null | undefined)[]): SpendTotal {
  let total: number | null = null;
  let estimated = false;
  let unknown = 0;
  for (const u of usages) {
    const s = spendOf(u);
    if (s.costUsd === null) {
      unknown++;
      continue;
    }
    total = (total ?? 0) + s.costUsd;
    if (s.kind === "estimated") estimated = true;
  }
  if (total === null) return { kind: "na", costUsd: null, unknown };
  return { kind: estimated ? "estimated" : "exact", costUsd: total, unknown };
}

/** "$0.42", "≈$0.42 (estimated)" or "n/a", in the person's language. */
export function spendText(view: SpendView, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (view.costUsd === null) return t("fleet.spendNa");
  const cost = formatUsd(view.costUsd);
  return view.kind === "estimated" ? t("fleet.spendEstimated", { cost }) : cost;
}

/**
 * A total's text: "$0.42", "≈$0.42 (estimated) · 1 session n/a" when some
 * sessions' cost is unknown, "n/a" when none is known, and null when there
 * is no session to add up (nothing is shown).
 */
export function spendTotalText(total: SpendTotal, t: (key: string, vars?: Record<string, string | number>) => string): string | null {
  if (total.costUsd === null) return total.unknown > 0 ? t("fleet.spendNa") : null;
  const known = spendText(total, t);
  if (total.unknown === 0) return known;
  const unknown = t(total.unknown === 1 ? "fleet.spendUnknownOne" : "fleet.spendUnknownMany", { count: total.unknown });
  return `${known} · ${unknown}`;
}

/** The cost a spend cap acts on: only what the agent itself reported. */
export function cappableCost(usage: UsageLike | null | undefined): ReportedCost {
  const s = spendOf(usage);
  return s.kind === "exact" ? s.costUsd : null;
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
