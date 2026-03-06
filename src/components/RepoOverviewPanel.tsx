import { useState, useEffect, useCallback, useMemo } from "react";
import { listWorktrees, gitListBranches, gitStatus } from "../api/git";
import type { WorktreeInfo, GitBranch } from "../types/git";
import "../styles/components/RepoOverviewPanel.css";

interface RepoOverviewPanelProps {
  realmId?: string;
  /** A sessionId to use for branch listing (any active session on this repo). */
  sessionId: string;
  onOpenSession: (sessionId: string) => void;
  onCreateSession: (branchName?: string) => void;
}

/**
 * Panel showing all active sessions and available branches for a repo.
 * Designed for the sidebar, giving a repo-level view across sessions.
 */
export function RepoOverviewPanel({
  realmId: realmIdProp,
  sessionId,
  onOpenSession,
  onCreateSession,
}: RepoOverviewPanelProps) {
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAvailable, setShowAvailable] = useState(false);
  const [resolvedRealmId, setResolvedRealmId] = useState<string | null>(realmIdProp || null);

  // Auto-detect realmId from the session's git status if not provided
  useEffect(() => {
    if (realmIdProp) {
      setResolvedRealmId(realmIdProp);
      return;
    }
    gitStatus(sessionId)
      .then((status) => {
        const gitProject = status.projects.find((p) => p.is_git_repo);
        if (gitProject) setResolvedRealmId(gitProject.project_id);
      })
      .catch(() => {});
  }, [sessionId, realmIdProp]);

  const loadData = useCallback(async () => {
    if (!resolvedRealmId) return;
    try {
      setLoading(true);
      setError(null);
      const [wt, br] = await Promise.all([
        listWorktrees(resolvedRealmId),
        gitListBranches(sessionId, resolvedRealmId),
      ]);
      setWorktrees(wt);
      setBranches(br);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [resolvedRealmId, sessionId]);

  useEffect(() => {
    if (resolvedRealmId) loadData();
  }, [loadData, resolvedRealmId]);

  // Branches checked out in worktrees
  const checkedOutBranches = useMemo(() => {
    const set = new Set<string>();
    for (const wt of worktrees) {
      if (wt.branchName) set.add(wt.branchName);
    }
    return set;
  }, [worktrees]);

  // Local branches not checked out in any worktree
  const availableBranches = useMemo(() => {
    return branches.filter(
      (b) => !b.is_remote && !b.is_current && !checkedOutBranches.has(b.name),
    );
  }, [branches, checkedOutBranches]);

  return (
    <div className="repo-overview-panel">
      <div className="repo-overview-toolbar">
        <span className="repo-overview-title">REPO OVERVIEW</span>
        <button
          className="git-panel-refresh"
          onClick={loadData}
          title="Refresh"
        >
          &#8635;
        </button>
      </div>

      <div className="repo-overview-scroll">
        {loading && (
          <div className="git-empty">Loading...</div>
        )}

        {error && (
          <div className="git-error">{error}</div>
        )}

        {!loading && !error && (
          <>
            {/* Active Sessions */}
            <div className="repo-overview-section">
              <div className="git-file-group-header">
                <span className="git-file-group-label">
                  ACTIVE SESSIONS ({worktrees.length})
                </span>
              </div>

              {worktrees.length === 0 && (
                <div className="git-empty">No active sessions on this repo</div>
              )}

              {worktrees.map((wt) => (
                <div
                  key={wt.sessionId}
                  className="repo-overview-worktree-row"
                  onClick={() => onOpenSession(wt.sessionId)}
                >
                  <svg
                    className="repo-overview-branch-icon"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                    width="14"
                    height="14"
                    aria-hidden="true"
                  >
                    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                  </svg>
                  <span className="repo-overview-branch-name">
                    {wt.branchName || "(detached)"}
                  </span>
                  <span className="repo-overview-session-label">
                    {wt.sessionLabel}
                  </span>
                </div>
              ))}
            </div>

            {/* Available Branches */}
            <div className="repo-overview-section">
              <div
                className="git-file-group-header repo-overview-available-header"
                onClick={() => setShowAvailable((v) => !v)}
              >
                <span className="git-file-group-label">
                  {showAvailable ? "▾" : "▸"} AVAILABLE BRANCHES ({availableBranches.length})
                </span>
              </div>

              {showAvailable && (
                <>
                  {availableBranches.length === 0 && (
                    <div className="git-empty">
                      All branches are in use
                    </div>
                  )}
                  {availableBranches.map((b) => (
                    <div
                      key={b.name}
                      className="repo-overview-available-row"
                      onClick={() => onCreateSession(b.name)}
                      title={`Create new session on ${b.name}`}
                    >
                      <svg
                        className="repo-overview-branch-icon repo-overview-branch-icon-muted"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        width="14"
                        height="14"
                        aria-hidden="true"
                      >
                        <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z" />
                      </svg>
                      <span className="repo-overview-available-name">
                        {b.name}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* New Session Button */}
            <div className="repo-overview-create-area">
              <button
                className="git-branch-new-btn"
                onClick={() => onCreateSession()}
              >
                + New Session on Branch...
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
