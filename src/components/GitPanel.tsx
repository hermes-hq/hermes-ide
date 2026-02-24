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

export function GitPanel({ visible }: GitPanelProps) {
  const { state } = useSession();
  const [pollInterval, setPollInterval] = useState(3000);
  const { status, error, refresh } = useGitStatus(state.activeSessionId, visible, pollInterval);
  const [diffTarget, setDiffTarget] = useState<{ projectPath: string; file: GitFile } | null>(null);

  // Load poll interval setting on mount
  useEffect(() => {
    getSettings().then((s) => {
      const val = parseInt(s.git_poll_interval || "3000", 10);
      if (val > 0) setPollInterval(val);
      else if (s.git_poll_interval === "0") setPollInterval(0);
    }).catch(() => {});
  }, []);

  // 2B: Clear diff when session changes
  useEffect(() => {
    setDiffTarget(null);
  }, [state.activeSessionId]);

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
          />
        ))}
      </div>

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
