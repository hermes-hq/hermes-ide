// ─── "limited" in the session list (N19) ──────────────────────────────
//
// Shown while the agent says it is on its usage limit, with the reset time
// when the agent reported one, and (with the launch helper on) a way to
// hand the task to another agent.

import { useEffect, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { isLimited, limitDescription } from "../limits/limitStatus";
import { useSessionStatus } from "../agent/status/attentionStore";

interface SessionLimitTagProps {
  sessionId: string;
  /** Opens the handoff dialog; absent when handoff is not available. */
  onHandOff?: () => void;
  /**
   * The row also shows the session's status tag (F10): when that already
   * says "limited", the word is not repeated here (the reset time and the
   * handoff stay).
   */
  withStatusTag?: boolean;
}

export function SessionLimitTag({ sessionId, onHandOff, withStatusTag = false }: SessionLimitTagProps) {
  const { t } = useI18n();
  const snapshot = useSessionEvents(sessionId);
  const statusKind = useSessionStatus(sessionId).kind;
  const wordShown = withStatusTag && statusKind === "limited";
  const [now, setNow] = useState(() => Date.now());
  const limited = isLimited(snapshot);

  // Re-render once a minute while limited, so "resets 14:00" turns into
  // "reset time passed" without any new event.
  useEffect(() => {
    if (!limited) return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [limited]);

  const limit = limitDescription(snapshot, now, t);
  if (!limit) return null;
  return (
    <span
      className="session-limit-tag"
      data-status="limited"
      // Only the agent's own nonce-verified hooks report a limit.
      data-confidence="exact"
      data-resets-at={limit.resetsAt ?? undefined}
      title={limit.detail}
    >
      {!wordShown && <span className="session-limit-word">{t("limits.limited")}</span>}
      <span className="session-limit-detail">{limit.detail}</span>
      {onHandOff && (
        <button
          type="button"
          className="session-limit-handoff"
          onClick={(e) => {
            e.stopPropagation();
            onHandOff();
          }}
        >
          {t("handoff.open")}
        </button>
      )}
    </span>
  );
}
