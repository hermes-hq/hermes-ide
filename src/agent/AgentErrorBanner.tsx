import "../styles/components/agent/AgentErrorBanner.css";
import { useMemo, useSyncExternalStore } from "react";
import { getI18nSnapshot, subscribeI18n, translate } from "../i18n/registry";
import type { AgentErrorView, Translate } from "./agentErrors";

/**
 * The i18n `t`, as a new function whenever the interface language changes
 * (so memos that depend on it re-run). Reads the registry directly instead
 * of useI18n so the Agent view, and the tests that mount it on its own, do
 * not need an I18nProvider above it.
 */
export function useAgentErrorTranslate(): Translate {
  const { currentLanguage } = useSyncExternalStore(subscribeI18n, getI18nSnapshot, getI18nSnapshot);
  return useMemo<Translate>(
    () => (key, values) => translate(key, values),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh `t` per language is the point
    [currentLanguage],
  );
}

interface AgentErrorBannerProps {
  error: AgentErrorView;
  /** True while a restart started from this banner is in flight. */
  retrying: boolean;
  onRetry: () => void;
  onSignIn: () => void;
  onDismiss: () => void;
}

/**
 * The Agent view's error panel: what went wrong, in one sentence, and the
 * one action that fixes it. `data-kind` carries the typed kind (see
 * agentErrors.ts) for styling and for tests.
 *
 * Retry stays clickable while a restart runs: a second click joins the
 * restart already in progress (the per-session respawn lock, see
 * utils/respawnQueue.ts and the backend's agent/respawn.rs), so it never
 * starts a second agent process.
 */
export function AgentErrorBanner({ error, retrying, onRetry, onSignIn, onDismiss }: AgentErrorBannerProps) {
  const t = useAgentErrorTranslate();
  return (
    <div className="agent-error-banner" role="alert" data-kind={error.kind}>
      <div className="agent-error-banner-title">{error.title}</div>
      <div className="agent-error-banner-message">{error.message}</div>
      {error.detail ? (
        <details className="agent-error-banner-details">
          <summary>{t("agentError.details")}</summary>
          <pre className="agent-error-banner-detail">{error.detail}</pre>
        </details>
      ) : null}
      {error.action ? (
        <div className="agent-error-banner-actions">
          {error.action === "retry" ? (
            <button
              type="button"
              className="agent-error-banner-action"
              data-action="retry"
              aria-busy={retrying}
              onClick={onRetry}
            >
              {retrying ? t("agentError.restarting") : t("agentError.retry")}
            </button>
          ) : error.action === "sign-in" ? (
            <button
              type="button"
              className="agent-error-banner-action"
              data-action="sign-in"
              onClick={onSignIn}
            >
              {t("agentError.signIn")}
            </button>
          ) : (
            <button
              type="button"
              className="agent-error-banner-action"
              data-action="dismiss"
              onClick={onDismiss}
            >
              {t("agentError.dismiss")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
