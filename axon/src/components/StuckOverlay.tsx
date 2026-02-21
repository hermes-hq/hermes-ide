import "../styles/components/StuckOverlay.css";
import { SessionData } from "../state/SessionContext";

interface StuckOverlayProps {
  session: SessionData;
  onDismiss: () => void;
  onSendCtrlC: () => void;
}

export function StuckOverlay({ session, onDismiss, onSendCtrlC }: StuckOverlayProps) {
  const lastError = session.metrics.recent_errors.length > 0
    ? session.metrics.recent_errors[session.metrics.recent_errors.length - 1]
    : null;

  const stuckLevel = session.metrics.stuck_score > 0.7 ? "high" : "medium";

  return (
    <div className="stuck-overlay-backdrop" onClick={onDismiss}>
      <div className="stuck-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="stuck-overlay-header">
          <span className="stuck-overlay-icon">{stuckLevel === "high" ? "!!" : "!"}</span>
          <span className="stuck-overlay-title">
            {stuckLevel === "high" ? "Session is stuck" : "Session appears to be struggling"}
          </span>
        </div>
        {lastError ? (
          <div className="stuck-overlay-error mono">{lastError}</div>
        ) : (
          <div className="stuck-overlay-error mono">Repeated error pattern detected</div>
        )}
        <div className="stuck-overlay-info">
          {session.metrics.error_count} errors detected
          {session.metrics.stuck_score > 0 && ` · Confidence: ${Math.round(session.metrics.stuck_score * 100)}%`}
        </div>
        <div className="stuck-overlay-actions">
          <button className="stuck-btn stuck-btn-danger" onClick={onSendCtrlC}>Send Ctrl+C</button>
          <button className="stuck-btn" onClick={() => {
            navigator.clipboard.writeText(session.metrics.recent_errors.join("\n"));
          }}>Copy Errors</button>
          <button className="stuck-btn" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}
