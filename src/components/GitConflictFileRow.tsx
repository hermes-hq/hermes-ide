import { memo } from "react";
import type { ConflictStrategy } from "../types/git";

// ─── Props ───────────────────────────────────────────────────────────

interface GitConflictFileRowProps {
  filePath: string;
  resolved: boolean;
  resolvedStrategy?: string;
  onResolve: (filePath: string, strategy: ConflictStrategy) => void;
  onView: (filePath: string) => void;
}

// ─── Component ───────────────────────────────────────────────────────

export const GitConflictFileRow = memo(function GitConflictFileRow({
  filePath,
  resolved,
  resolvedStrategy,
  onResolve,
  onView,
}: GitConflictFileRowProps) {
  const rowClassName = resolved
    ? "git-conflict-row git-conflict-row-resolved"
    : "git-conflict-row";

  return (
    <div className={rowClassName}>
      {/* Status indicator */}
      <span
        className={
          resolved
            ? "git-conflict-indicator git-conflict-indicator-resolved"
            : "git-conflict-indicator git-conflict-indicator-unresolved"
        }
      >
        {resolved ? "\u2713" : "!"}
      </span>

      {/* File path */}
      <span className="git-conflict-path" title={filePath}>
        {filePath}
      </span>

      {/* Actions or resolved label */}
      {resolved ? (
        <span className="git-conflict-resolved-label">
          (resolved{resolvedStrategy ? ` \u2014 ${resolvedStrategy}` : ""})
        </span>
      ) : (
        <div className="git-conflict-actions">
          <button
            className="git-conflict-btn git-conflict-btn-view"
            title="View conflict content"
            onClick={(e) => {
              e.stopPropagation();
              onView(filePath);
            }}
          >
            View
          </button>
          <button
            className="git-conflict-btn git-conflict-btn-ours"
            title="Accept our changes"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(filePath, "ours");
            }}
          >
            Ours
          </button>
          <button
            className="git-conflict-btn git-conflict-btn-theirs"
            title="Accept their changes"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(filePath, "theirs");
            }}
          >
            Theirs
          </button>
          <button
            className="git-conflict-btn git-conflict-btn-resolved"
            title="Mark as manually resolved"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(filePath, "manual");
            }}
          >
            Mark Resolved
          </button>
        </div>
      )}
    </div>
  );
}, (prev, next) =>
  prev.filePath === next.filePath &&
  prev.resolved === next.resolved &&
  prev.resolvedStrategy === next.resolvedStrategy &&
  prev.onResolve === next.onResolve &&
  prev.onView === next.onView
);
