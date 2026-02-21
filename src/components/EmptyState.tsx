import "../styles/components/EmptyState.css";
import { SessionHistoryEntry } from "../state/SessionContext";

interface EmptyStateProps {
  recentSessions: SessionHistoryEntry[];
  onNew: () => void;
  onRestore: (entry: SessionHistoryEntry, restoreScrollback: boolean) => void;
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function projectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const home = parts.indexOf("Users");
  if (home >= 0 && parts.length > home + 2) return parts.slice(home + 2).join("/");
  return parts[parts.length - 1] || path;
}

export function EmptyState({ recentSessions, onNew, onRestore }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state-logo">HERMES-IDE</div>
      <p className="empty-state-subtitle">AI-native terminal for macOS</p>
      <p className="empty-state-hint">Drop a session here or press <kbd>⌘N</kbd> to start</p>

      <div className="empty-state-actions">
        <button className="btn-primary" onClick={onNew}>New Session</button>
      </div>

      <div className="empty-state-shortcuts">
        <span><kbd>⌘N</kbd> New session</span>
        <span><kbd>⌘K</kbd> Command palette</span>
        <span><kbd>⌘E</kbd> Toggle context</span>
      </div>

      {recentSessions.length > 0 && (
        <div className="empty-state-recent">
          <div className="empty-state-recent-title">Recent Sessions</div>
          {recentSessions.slice(0, 5).map((entry) => (
            <button
              key={entry.id}
              className="empty-state-recent-item"
              onClick={() => onRestore(entry, true)}
            >
              <span className="recent-dot" style={{ background: entry.color }} />
              <span className="recent-label">{entry.label}</span>
              <span className="recent-path">{projectName(entry.working_directory)}</span>
              {entry.closed_at && <span className="recent-time">{timeAgo(entry.closed_at)}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
