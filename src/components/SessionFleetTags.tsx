// Session-row tags for running many agents (F14, F24): how full the agent's
// context window is, and how much memory the session's processes use.

import { useSessionEvents } from "../agent/contract/sessionEventStore";
import { contextGauge } from "../utils/contextGauge";
import { formatMemory, useSessionMemory } from "../hooks/useFleetMemory";
import { isFeatureFlagEnabled } from "../featureFlags";
import { useI18n } from "../i18n/I18nProvider";

/** Shown only once the agent itself reported its context usage. */
export function SessionContextGauge({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const { context } = useSessionEvents(sessionId);
  const gauge = contextGauge(context);
  if (!gauge) return null;
  const title = t("fleet.contextTitle", {
    used: gauge.usedTokens.toLocaleString(),
    limit: gauge.contextLimit.toLocaleString(),
    percent: String(gauge.percent),
  });
  return (
    <span
      className="session-context-gauge"
      data-level={gauge.level}
      data-percent={gauge.percent}
      title={title}
      aria-label={title}
    >
      <span className="session-context-gauge-bar" aria-hidden="true">
        <span className="session-context-gauge-fill" style={{ width: `${gauge.percent}%` }} />
      </span>
      <span className="session-context-gauge-text">{t("fleet.contextShort", { percent: String(gauge.percent) })}</span>
    </span>
  );
}

function MemoryTag({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const bytes = useSessionMemory(sessionId);
  if (bytes === null) return null;
  const size = formatMemory(bytes);
  return (
    <span className="session-memory-tag" data-bytes={bytes} title={t("fleet.memoryTitle", { size })}>
      {size}
    </span>
  );
}

/** Behind the fleetPerf flag (read once at startup). */
export function SessionMemoryTag({ sessionId }: { sessionId: string }) {
  return isFeatureFlagEnabled("fleetPerf") ? <MemoryTag sessionId={sessionId} /> : null;
}
