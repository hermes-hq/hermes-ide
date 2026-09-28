// Session-row badges for the fleet controls (flag `fleetControls`):
//
//   - spend: what the agent reported it spent ("$0.42"), or "n/a" when it
//     does not report a cost; "cap reached" once a spend cap stopped it (F31)
//   - overlap: this session's latest turns touched a file another session's
//     latest turns touched too (F37)

import "../styles/components/Fleet.css";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { useI18n } from "../i18n/I18nProvider";
import type { SessionData } from "../types/session";
import { useSessionOverlap } from "./radarStore";
import { formatUsd } from "./spend";
import { useSessionCapTrip } from "./spendCapWatcher";

/** Shown for every session with an agent (started as one, or recognised in
 *  its terminal) and for any session whose agent reported usage. */
export function SessionSpendChip({ session }: { session: Pick<SessionData, "id" | "ai_provider"> & { detected_agent?: SessionData["detected_agent"] } }) {
  const { t } = useI18n();
  const { usage } = useSessionEvents(session.id);
  const trip = useSessionCapTrip(session.id);
  if (!session.ai_provider && !session.detected_agent && !usage) return null;
  const cost = usage?.costUsd ?? null;
  const text = cost === null ? t("fleet.spendNa") : formatUsd(cost);
  const tokens = usage && (usage.inputTokens !== null || usage.outputTokens !== null)
    ? t("fleet.spendTokens", {
        input: usage.inputTokens === null ? t("fleet.spendNa") : usage.inputTokens.toLocaleString(),
        output: usage.outputTokens === null ? t("fleet.spendNa") : usage.outputTokens.toLocaleString(),
      })
    : "";
  const title = [cost === null ? t("fleet.spendNotReported") : t("fleet.spendReported"), tokens].filter(Boolean).join("\n");
  return (
    <>
      <span
        className="session-spend"
        data-spend={cost === null ? "na" : "exact"}
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
