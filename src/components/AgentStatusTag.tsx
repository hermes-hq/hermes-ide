import "../styles/components/AgentStatusTag.css";
import { useI18n } from "../i18n/I18nProvider";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { useSessionStatus } from "../agent/status/attentionStore";
import { statusLabel } from "../agent/status/presentation";

/**
 * A session's status as a glyph and a word (F10). Colour is only a third
 * cue; a guessed status is dimmed and says "guessed". The detail line and
 * how sure Hermes is are in the tooltip. Reads only the session's events,
 * never an agent's own state.
 */
export function AgentStatusTag({ sessionId, variant = "list" }: { sessionId: string; variant?: "list" | "strip" }) {
  const { t } = useI18n();
  const status = useSessionStatus(sessionId);
  const { exit } = useSessionEvents(sessionId);
  const label = statusLabel({ ...status, exit }, t);
  return (
    <span
      className={`agent-status-tag agent-status-tag-${variant}`}
      data-status={status.kind}
      data-confidence={status.confidence}
      data-tone={label.tone}
      title={label.title}
    >
      <span className="agent-status-glyph" aria-hidden="true">{label.glyph}</span>
      <span className="agent-status-word">{label.word}</span>
      {label.guessed && <span className="agent-status-guessed">{label.guessed}</span>}
    </span>
  );
}
