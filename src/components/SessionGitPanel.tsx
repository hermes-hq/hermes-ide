import { useState, useCallback, useEffect } from "react";
import { useGitStatus } from "../hooks/useGitStatus";
import { getSessionWorktreeInfo } from "../api/git";
import { getSettings } from "../api/settings";
import { GitProjectSection } from "./GitProjectSection";
import { GitDiffView } from "./GitDiffView";
import { WorktreeIndicator } from "./WorktreeIndicator";
import { WorktreeOverviewPanel } from "./WorktreeOverviewPanel";
import { isFeatureFlagEnabled } from "../featureFlags";
import type { GitFile, SessionWorktree } from "../types/git";
import type { GitToast } from "./GitPanel";
import "../styles/components/SessionGitPanel.css";

interface SessionGitPanelProps {
  sessionId: string;
  projectId: string;
}

/**
 * Per-session git panel that replaces the global GitPanel.
 * Scoped to a single session's worktree — shows branch selector,
 * staged/unstaged files, commit area, stash, and log.
 *
 * This is a thin wrapper that reuses existing GitProjectSection
 * sub-components, scoped to the session's worktree.
 */
export function SessionGitPanel({ sessionId, projectId }: SessionGitPanelProps) {
  const [pollInterval, setPollInterval] = useState(3000);
  const { status, error, refresh } = useGitStatus(sessionId, true, pollInterval);
  const [diffTarget, setDiffTarget] = useState<{ sessionId: string; projectId: string; file: GitFile } | null>(null);
  const [toast, setToast] = useState<GitToast | null>(null);
  const [worktreeInfo, setWorktreeInfo] = useState<SessionWorktree | null>(null);
  // Disk guard (feature flag): a Worktrees view with disk use and cleanup.
  const diskGuard = isFeatureFlagEnabled("diskGuard");
  const [view, setView] = useState<"changes" | "worktrees">("changes");

  // Load poll interval setting on mount
  useEffect(() => {
    getSettings()
      .then((s) => {
        const val = parseInt(s.git_poll_interval || "3000", 10);
        if (val > 0) setPollInterval(val);
        else if (s.git_poll_interval === "0") setPollInterval(0);
      })
      .catch(() => {});
  }, []);

  // Load worktree info for this session
  useEffect(() => {
    getSessionWorktreeInfo(sessionId, projectId)
      .then((info) => setWorktreeInfo(info))
      .catch(() => {});
  }, [sessionId, projectId]);

  // Clear diff when session changes
  useEffect(() => {
    setDiffTarget(null);
  }, [sessionId]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((message: string, type: GitToast["type"] = "success") => {
    setToast({ message, type });
  }, []);

  const handleDiffFile = useCallback((sid: string, rid: string, file: GitFile) => {
    setDiffTarget({ sessionId: sid, projectId: rid, file });
  }, []);

  return (
    <div className="session-git-panel">
      {/* Header with session worktree info */}
      <div className="session-git-panel-toolbar">
        <span className="session-git-panel-title">GIT</span>
        {worktreeInfo && (
          <WorktreeIndicator
            sessionId={sessionId}
            branchName={worktreeInfo.branchName}
            isMainWorktree={worktreeInfo.isMainWorktree}
            isActive
          />
        )}
        <button
          className="git-panel-refresh"
          onClick={refresh}
          title="Refresh"
        >
          &#8635;
        </button>
      </div>

      {diskGuard && (
        <div className="git-view-toggle">
          <button
            className={`git-view-toggle-btn ${view === "changes" ? "git-view-toggle-btn-active" : ""}`}
            onClick={() => setView("changes")}
          >
            Changes
          </button>
          <button
            className={`git-view-toggle-btn ${view === "worktrees" ? "git-view-toggle-btn-active" : ""}`}
            onClick={() => setView("worktrees")}
          >
            Worktrees
          </button>
        </div>
      )}

      {view === "worktrees" && (
        <div className="session-git-panel-scroll">
          <WorktreeOverviewPanel />
        </div>
      )}

      <div className="session-git-panel-scroll" hidden={view !== "changes"}>
        {error && (
          <div className="git-error">{error}</div>
        )}

        {status && status.projects.length === 0 && !error && (
          <div className="git-empty-state">
            No git repositories found.
            <br />
            Attach a project with a git repo to this session.
          </div>
        )}

        {status && status.projects.map((project) => (
          <GitProjectSection
            key={project.project_id}
            sessionId={sessionId}
            projectId={project.project_id}
            project={project}
            onRefresh={refresh}
            onDiffFile={handleDiffFile}
            onToast={showToast}
          />
        ))}
      </div>

      {/* Floating toast at bottom of panel */}
      {toast && (
        <div className={`git-toast git-toast-${toast.type}`} key={toast.message}>
          <span className="git-toast-icon">
            {toast.type === "success" ? "\u2713" : toast.type === "error" ? "\u2717" : "\u2139"}
          </span>
          {toast.message}
        </div>
      )}

      {diffTarget && (
        <GitDiffView
          sessionId={diffTarget.sessionId}
          projectId={diffTarget.projectId}
          file={diffTarget.file}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </div>
  );
}
