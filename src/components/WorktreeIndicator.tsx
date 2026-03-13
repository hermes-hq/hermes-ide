import "../styles/components/WorktreeIndicator.css";

interface WorktreeIndicatorProps {
  sessionId?: string;
  branchName: string | null;
  isMainWorktree?: boolean;
  isActive?: boolean;
}

/**
 * Small pill/badge showing the branch name for a session list item.
 * Distinguishes between main checkout and linked worktrees.
 */
export function WorktreeIndicator({
  branchName,
  isMainWorktree = false,
  isActive = false,
}: WorktreeIndicatorProps) {
  if (!branchName) return null;

  return (
    <span
      className={`worktree-indicator ${isActive ? "worktree-indicator-active" : ""}`}
      title={isMainWorktree ? `${branchName} (main checkout)` : `${branchName} (linked worktree)`}
    >
      {/* Different icon for linked vs main */}
      {isMainWorktree ? (
        // Folder icon for main checkout
        <svg className="worktree-indicator-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden="true">
          <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7Z" />
        </svg>
      ) : (
        // Link icon for linked worktree
        <svg className="worktree-indicator-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12" aria-hidden="true">
          <path d="M4.75 3.5a3.25 3.25 0 0 0 0 6.5h1.5a.75.75 0 0 1 0 1.5h-1.5a4.75 4.75 0 0 1 0-9.5h1.5a.75.75 0 0 1 0 1.5ZM11.25 3.5a4.75 4.75 0 0 1 0 9.5h-1.5a.75.75 0 0 1 0-1.5h1.5a3.25 3.25 0 0 0 0-6.5h-1.5a.75.75 0 0 1 0-1.5Zm-6 4.25a.75.75 0 0 0 0 1.5h5.5a.75.75 0 0 0 0-1.5Z" />
        </svg>
      )}
      <span className="worktree-indicator-branch">{branchName}</span>
    </span>
  );
}
