// Session-row badges for the fleet controls (flag `fleetControls`):
//
//   - spend: what the agent reported it spent ("$0.42"), Hermes's estimate
//     from its transcript ("≈$0.42 (estimated)"), or "n/a" when it
//     does not report a cost; "cap reached" once a spend cap stopped it (F31)
//   - overlap: this session's latest turns touched a file another session's
//     latest turns touched too (F37)

import "../styles/components/Fleet.css";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { useI18n } from "../i18n/I18nProvider";
import type { SessionData } from "../types/session";
import { useSessionOverlap } from "./radarStore";
import { formatUsd, spendOf, spendText, spendTotalParts, spendTotalText } from "./spend";
import { useSessionCapTrip } from "./spendCapWatcher";
import { spendTotalTitle, totalOf, useReportedTotals, type SpendMember } from "./useReportedTotals";

/** Shown for every session with an agent (started as one, or recognised in
 *  its terminal) and for any session whose agent reported usage. */
export function SessionSpendChip({ session }: { session: Pick<SessionData, "id" | "ai_provider"> & { detected_agent?: SessionData["detected_agent"] } }) {
  const { t } = useI18n();
  const { usage } = useSessionEvents(session.id);
  const trip = useSessionCapTrip(session.id);
  if (!session.ai_provider && !session.detected_agent && !usage) return null;
  const spend = spendOf(usage);
  const text = spendText(spend, t);
  const tokens = usage && (usage.inputTokens !== null || usage.outputTokens !== null)
    ? t("fleet.spendTokens", {
        input: usage.inputTokens === null ? t("fleet.spendNa") : usage.inputTokens.toLocaleString(),
        output: usage.outputTokens === null ? t("fleet.spendNa") : usage.outputTokens.toLocaleString(),
      })
    : "";
  const why = spend.kind === "na" ? t("fleet.spendNotReported") : spend.kind === "estimated" ? t("fleet.spendEstimatedTitle") : t("fleet.spendReported");
  const title = [why, tokens].filter(Boolean).join("\n");
  return (
    <>
      <span
        className="session-spend"
        data-spend={spend.kind}
        title={title}
      >
        {text}
      </span>
      {trip && (
        <span className="session-cap-reached" data-cap-kind={trip.kind} title={trip.kind === "feature" ? trip.label : undefined}>
          {t("fleet.capReached", { cap: formatUsd(trip.capUsd) })}
        </span>
      )}
    </>
  );
}

export function SessionOverlapBadge({ sessionId, labelOf }: { sessionId: string; labelOf: (id: string) => string }) {
  const { t } = useI18n();
  const overlap = useSessionOverlap(sessionId);
  if (!overlap || overlap.others.length === 0) return null;
  const lines = overlap.others.map((o) => t("fleet.overlapWith", { name: labelOf(o.sessionId), files: o.files.join(", ") }));
  const count = new Set(overlap.others.flatMap((o) => o.files)).size;
  return (
    <span
      className="session-overlap-badge"
      data-overlap-with={overlap.others.map((o) => o.sessionId).join(" ")}
      title={lines.join("\n")}
      aria-label={lines.join(". ")}
    >
      {t("fleet.overlap", { count: String(count) })}
    </span>
  );
}

/**
 * A project header's spend: the sum of its sessions' usage, the same
 * numbers their rows show, and how many of them have no known cost
 * ("≈$0.37 (estimated) · 1 n/a"); "n/a" when none has. Nothing
 * when the project has no agent session.
 */
export function ProjectSpend({ sessions }: { sessions: readonly SpendMember[] }) {
  const { t } = useI18n();
  const totals = useReportedTotals(sessions);
  // The header is narrow: the count is short ("≈$0.37 (estimated) · 1 n/a"),
  // and " (estimated)" is cut short first, so the amount and the count stay
  // whole. The tooltip has it all ("… · 1 session n/a" and the names).
  const parts = spendTotalParts(totalOf(totals), t, { short: true });
  if (parts === null) return null;
  const full = spendTotalText(totalOf(totals), t) ?? "";
  return (
    <span className="project-header-cost" data-spend={totals.spend} data-unknown={totals.unknown.length} title={spendTotalTitle(full, totals, t)}>
      <span className="project-header-cost-amount">{parts.amount}</span>
      {parts.qualifier && <span className="project-header-cost-qualifier">{parts.qualifier}</span>}
      {parts.unknown && <span className="project-header-cost-unknown">{parts.unknown}</span>}
    </span>
  );
}
