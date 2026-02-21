import "../styles/components/ContextStatusBar.css";
import { type ContextManager } from "../hooks/useContextState";

interface ContextStatusBarProps {
  manager: ContextManager;
  autoApplyEnabled: boolean;
  onToggleAutoApply: () => void;
}

function timeAgoShort(ts: number | null): string {
  if (!ts) return "never";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function ContextStatusBar({ manager, autoApplyEnabled, onToggleAutoApply }: ContextStatusBarProps) {
  const { currentVersion, injectedVersion, lastInjectedAt, lifecycle, lastError, applyContext,
          tokenBudget, estimatedTokens } = manager;

  const isDirty = lifecycle === 'dirty' || lifecycle === 'apply_failed';
  const isApplying = lifecycle === 'applying';

  const budgetPercent = tokenBudget > 0 ? Math.min(100, Math.round((estimatedTokens / tokenBudget) * 100)) : 0;
  const budgetWarning = budgetPercent >= 80;
  const budgetCritical = budgetPercent >= 95;

  const barClass = [
    "ctx-status-bar",
    isDirty ? "ctx-status-bar-outofsync" : "",
    isApplying ? "ctx-status-bar-applying" : "",
    lifecycle === 'apply_failed' ? "ctx-status-bar-failed" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={barClass}>
      <div className="ctx-status-row">
        <div className="ctx-status-left">
          <span className="ctx-version-badge">v{currentVersion}</span>
          <span className="ctx-sync-time">{timeAgoShort(lastInjectedAt)}</span>
          {lifecycle === 'dirty' && (
            <span className="ctx-outofsync-indicator">
              Out of sync
            </span>
          )}
          {lifecycle === 'applying' && (
            <span className="ctx-applying-indicator">
              Applying...
            </span>
          )}
          {lifecycle === 'apply_failed' && (
            <span className="ctx-failed-indicator">
              Failed
            </span>
          )}
          {lifecycle === 'clean' && injectedVersion > 0 && (
            <span className="ctx-insync-indicator">
              In sync
            </span>
          )}
        </div>
        <div className="ctx-status-right">
          <button
            className="ctx-apply-btn"
            onClick={() => { applyContext().catch(console.error); }}
            disabled={lifecycle === 'clean' || lifecycle === 'applying'}
          >
            {isApplying ? "Applying..." : "Apply Context"}
          </button>
        </div>
      </div>

      {/* Token budget meter */}
      <div className="ctx-budget-row">
        <div className="ctx-budget-bar-track">
          <div
            className={[
              "ctx-budget-bar-fill",
              budgetCritical ? "ctx-budget-bar-critical" : budgetWarning ? "ctx-budget-bar-warning" : "",
            ].filter(Boolean).join(" ")}
            style={{ width: `${budgetPercent}%` }}
          />
        </div>
        <span className={`ctx-budget-label ${budgetCritical ? "ctx-budget-critical" : budgetWarning ? "ctx-budget-warning" : ""}`}>
          ~{estimatedTokens.toLocaleString()} / {tokenBudget.toLocaleString()} tokens ({budgetPercent}%)
        </span>
      </div>

      {/* Error message */}
      {lifecycle === 'apply_failed' && lastError && (
        <div className="ctx-apply-error">
          {lastError}
        </div>
      )}

      {/* Auto-apply toggle */}
      <div className="ctx-autoapply-row">
        <label className="ctx-autoapply-label">
          <input
            type="checkbox"
            checked={autoApplyEnabled}
            onChange={onToggleAutoApply}
            className="ctx-autoapply-checkbox"
          />
          Auto-apply on execution
        </label>
      </div>

      {/* Last injected info */}
      <div className="ctx-injected-info">
        {lastInjectedAt
          ? `Last injected: v${injectedVersion} ${timeAgoShort(lastInjectedAt)}`
          : "Never injected"
        }
      </div>
    </div>
  );
}
