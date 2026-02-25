import { useState, useCallback, useEffect } from "react";
import { useGitStatus } from "../hooks/useGitStatus";
import { useSession } from "../state/SessionContext";
import { GitProjectSection } from "./GitProjectSection";
import { GitDiffView } from "./GitDiffView";
import { getSettings } from "../api/settings";
import type { GitFile } from "../types/git";
import "../styles/components/GitPanel.css";

interface GitPanelProps {
  visible: boolean;
}

export interface GitToast {
  message: string;
  type: "success" | "info" | "error";
}

export function GitPanel({ visible }: GitPanelProps) {
  const { state } = useSession();
  const [pollInterval, setPollInterval] = useState(3000);
  const { status, error, refresh } = useGitStatus(state.activeSessionId, visible, pollInterval);
  const [diffTarget, setDiffTarget] = useState<{ projectPath: string; file: GitFile } | null>(null);
  const [toast, setToast] = useState<GitToast | null>(null);

  // Load poll interval setting on mount
  useEffect(() => {
    getSettings().then((s) => {
      const val = parseInt(s.git_poll_interval || "3000", 10);
      if (val > 0) setPollInterval(val);
      else if (s.git_poll_interval === "0") setPollInterval(0);
    }).catch(() => {});
  }, []);

  // Clear diff when session changes
  useEffect(() => {
    setDiffTarget(null);
  }, [state.activeSessionId]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const showToast = useCallback((message: string, type: GitToast["type"] = "success") => {
    setToast({ message, type });
  }, []);

  const handleDiffFile = useCallback((projectPath: string, file: GitFile) => {
    setDiffTarget({ projectPath, file });
  }, []);

  return (
    <div className="git-panel">
      <div className="git-panel-toolbar">
        <span className="git-panel-title">Git</span>
        <button className="git-panel-refresh" onClick={refresh} title="Refresh">
          &#8635;
        </button>
      </div>

      <div className="git-panel-scroll">
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
            project={project}
            onRefresh={refresh}
            onDiffFile={handleDiffFile}
            onToast={showToast}
          />
        ))}
      </div>

      {/* Floating toast at bottom of panel */}
      {toast && (
        <div className={`git-toast git-toast-${toast.type}`} key={toast.message + Date.now()}>
          <span className="git-toast-icon">
            {toast.type === "success" ? "\u2713" : toast.type === "error" ? "\u2717" : "\u2139"}
          </span>
          {toast.message}
        </div>
      )}

      {diffTarget && (
        <GitDiffView
          projectPath={diffTarget.projectPath}
          file={diffTarget.file}
          onClose={() => setDiffTarget(null)}
        />
      )}
    </div>
  );
}
