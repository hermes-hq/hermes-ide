import "../styles/components/agent/AgentErrorBanner.css";
import type { AgentErrorView } from "./agentErrors";

interface AgentErrorBannerProps {
  error: AgentErrorView;
  /** True while a restart started from this banner is in flight. */
  retrying: boolean;
  onRetry: () => void;
  onSignIn: () => void;
}

/**
 * The Agent view's error panel: what went wrong, in one sentence, and the
 * one action that fixes it. `data-kind` carries the typed kind (see
 * agentErrors.ts) for styling and for tests.
 *
 * Retry stays clickable while a restart runs: a second click joins the
 * restart already in progress (the backend's per-session spawn lock), so it
 * never starts a second agent process.
 */
export function AgentErrorBanner({ error, retrying, onRetry, onSignIn }: AgentErrorBannerProps) {
  return (
    <div className="agent-error-banner" role="alert" data-kind={error.kind}>
      <div className="agent-error-banner-title">{error.title}</div>
      <div className="agent-error-banner-message">{error.message}</div>
      {error.detail ? (
        <details className="agent-error-banner-details">
          <summary>Details</summary>
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
              {retrying ? "Restarting…" : "Retry"}
            </button>
          ) : (
            <button
              type="button"
              className="agent-error-banner-action"
              data-action="sign-in"
              onClick={onSignIn}
            >
              Sign in
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
