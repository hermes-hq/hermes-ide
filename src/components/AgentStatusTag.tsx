import "../styles/components/AgentStatusTag.css";
import { useI18n } from "../i18n/I18nProvider";
import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { useSessionStatus } from "../agent/status/attentionStore";
import { reporterOfSource, statusLabel } from "../agent/status/presentation";
import { getAgent } from "../catalog/agentCatalog";

/**
 * A session's status as a glyph and a word (F10), then how sure Hermes is:
 * "exact" or "signal" for a status someone reported, "guessed" (dimmed)
 * for Hermes's own guess. Colour is only a third cue. The detail line and
 * who said so ("Reported by Claude Code") are in the tooltip. Reads only
 * the session's events, never an agent's own state.
 */
export function AgentStatusTag({ sessionId, variant = "list" }: { sessionId: string; variant?: "list" | "strip" }) {
  const { t } = useI18n();
  const status = useSessionStatus(sessionId);
  const { exit } = useSessionEvents(sessionId);
  const agentName = getAgent(reporterOfSource(status.source))?.name ?? null;
  const label = statusLabel({ ...status, exit, agentName }, t);
  return (
    <span
      className={`agent-status-tag agent-status-tag-${variant}`}
      data-status={status.kind}
      data-confidence={status.confidence}
      data-source={status.source ?? ""}
      data-tone={label.tone}
      title={label.title}
    >
      <span className="agent-status-glyph" aria-hidden="true">{label.glyph}</span>
      <span className="agent-status-word">{label.word}</span>
      {label.sure && <span className="agent-status-sure">{label.sure}</span>}
      {label.guessed && <span className="agent-status-guessed">{label.guessed}</span>}
    </span>
  );
}
