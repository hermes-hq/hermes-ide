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
import { formatUsd, spendOf, spendText } from "./spend";
import { useSessionCapTrip } from "./spendCapWatcher";
import { useReportedTotals } from "./useReportedTotals";

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
 * numbers their rows show. Nothing when none of them has a known cost.
 */
export function ProjectSpend({ sessionIds }: { sessionIds: readonly string[] }) {
  const { t } = useI18n();
  const totals = useReportedTotals(sessionIds);
  if (totals.costUsd === null) return null;
  const text = spendText({ kind: totals.spend, costUsd: totals.costUsd }, t);
  // A narrow sidebar may cut the text short: the tooltip keeps all of it.
  const why = totals.spend === "estimated" ? t("fleet.spendEstimatedTitle") : t("fleet.spendReported");
  return (
    <span className="project-header-cost" data-spend={totals.spend} title={`${text}\n${why}`}>
      {text}
    </span>
  );
}
