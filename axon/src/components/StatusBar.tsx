import { setSetting } from "../api/settings";
import { useActiveSession, useSessionList, useTotalCost, useTotalTokens, useExecutionMode, useSession, ExecutionMode } from "../state/SessionContext";

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

export function StatusBar() {
  const active = useActiveSession();
  const sessions = useSessionList();
  const totalCost = useTotalCost();
  const totalTokens = useTotalTokens();
  const hasTokens = totalTokens.input + totalTokens.output > 0;
  const { dispatch } = useSession();
  const mode = useExecutionMode(active?.id ?? null);

  const cycleMode = () => {
    if (!active) return;
    const next: ExecutionMode = mode === "manual" ? "assisted" : mode === "assisted" ? "autonomous" : "manual";
    dispatch({ type: "SET_EXECUTION_MODE", sessionId: active.id, mode: next });
    dispatch({ type: "SET_DEFAULT_MODE", mode: next });
    setSetting("execution_mode", next).catch(console.error);
  };

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-bar-item">
          <span className={`status-dot ${sessions.length > 0 ? "status-dot-on" : ""}`} />
          {sessions.length} active
        </span>
        {active && (
          <>
            <span className="status-bar-divider" />
            <button
              className={`status-mode-btn status-mode-${mode}`}
              onClick={cycleMode}
              title={mode === "manual"
                ? "Manual: No automatic suggestions or execution. Click to switch."
                : mode === "assisted"
                ? "Assisted: Shows suggestions and lets you manually apply fixes. Click to switch."
                : "Autonomous: Automatically applies frequent commands and repeated fixes after countdown. Click to switch."}
            >
              <span className="status-mode-dot" />
              {mode === "manual" ? "Manual" : mode === "assisted" ? "Assisted" : "Auto"}
            </button>
          </>
        )}
        {active?.detected_agent && (
          <>
            <span className="status-bar-divider" />
            <span className="status-bar-item">
              {active.detected_agent.name}
              {active.detected_agent.model && <span className="status-bar-model"> ({active.detected_agent.model})</span>}
              {active.phase === "busy" && <span className="status-bar-busy">working</span>}
            </span>
          </>
        )}
        {active && active.metrics.error_count > 0 && (
          <>
            <span className="status-bar-divider" />
            <span className="status-bar-item text-red">{active.metrics.error_count} errors</span>
          </>
        )}
        {active && active.metrics.stuck_score > 0.5 && (
          <>
            <span className="status-bar-divider" />
            <span className="status-bar-item status-bar-stuck">
              {active.metrics.stuck_score > 0.7 ? "Stuck" : "Struggling"}
            </span>
          </>
        )}
      </div>
      <div className="status-bar-right">
        {hasTokens && (
          <>
            <span className="status-bar-item status-bar-tokens" title={`Input: ${totalTokens.input.toLocaleString()} · Output: ${totalTokens.output.toLocaleString()}`}>
              {formatTokens(totalTokens.input + totalTokens.output)} tokens
            </span>
            <span className="status-bar-divider" />
          </>
        )}
        {totalCost > 0 && (
          <>
            <span className="status-bar-item status-bar-cost">${totalCost.toFixed(2)}</span>
            <span className="status-bar-divider" />
          </>
        )}
        {active && (
          <>
            <span className="status-bar-item mono">{active.shell.split("/").pop()}</span>
            <span className="status-bar-divider" />
            <span className="status-bar-item mono truncate">{active.working_directory}</span>
            <span className="status-bar-divider" />
          </>
        )}
        {active && <span className="status-bar-item"><kbd className="status-kbd">⌘J</kbd></span>}
        <span className="status-bar-item"><kbd className="status-kbd">⌘K</kbd></span>
      </div>
    </div>
  );
}
