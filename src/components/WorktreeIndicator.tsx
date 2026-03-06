import "../styles/components/WorktreeIndicator.css";

interface WorktreeIndicatorProps {
  sessionId?: string;
  branchName: string | null;
  isMainWorktree?: boolean;
  isActive?: boolean;
}

/**
 * Small pill/badge showing the branch name for a session list item.
 */
export function WorktreeIndicator({
  branchName,
  isActive = false,
}: WorktreeIndicatorProps) {
  if (!branchName) return null;

  return (
    <span
      className={`worktree-indicator ${isActive ? "worktree-indicator-active" : ""}`}
      title={branchName}
    >
      {/* Git branch icon */}
      <svg
        className="worktree-indicator-icon"
        viewBox="0 0 16 16"
        fill="currentColor"
        width="12"
        height="12"
        aria-hidden="true"
      >
        <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
      </svg>
      <span className="worktree-indicator-branch">{branchName}</span>
    </span>
  );
}
