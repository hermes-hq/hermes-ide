import { useState, useCallback, useMemo, useEffect } from "react";
import type { GitProjectStatus, GitFile } from "../types/git";
import { gitStage, gitUnstage, gitCommit, gitPush, gitPull, gitOpenFile } from "../api/git";
import { getSettings } from "../api/settings";
import { GitFileRow } from "./GitFileRow";

interface GitProjectSectionProps {
  project: GitProjectStatus;
  onRefresh: () => void;
  onDiffFile: (projectPath: string, file: GitFile) => void;
}

export function GitProjectSection({ project, onRefresh, onDiffFile }: GitProjectSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const [commitMsg, setCommitMsg] = useState("");
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);
  const [autoStage, setAutoStage] = useState(false);

  const staged = useMemo(() => project.files.filter((f) => f.area === "staged"), [project.files]);
  const unstaged = useMemo(() => project.files.filter((f) => f.area === "unstaged"), [project.files]);
  const untracked = useMemo(() => project.files.filter((f) => f.area === "untracked"), [project.files]);

  const totalChanges = project.files.length;

  // Load auto-stage setting
  useEffect(() => {
    getSettings().then((s) => {
      setAutoStage(s.git_auto_stage === "true");
    }).catch(() => {});
  }, []);

  // 2D: Auto-dismiss errors after 8 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  // Clear commit success after 3 seconds
  useEffect(() => {
    if (!commitSuccess) return;
    const timer = setTimeout(() => setCommitSuccess(false), 3000);
    return () => clearTimeout(timer);
  }, [commitSuccess]);

  const handleStage = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitStage(project.project_path, [path]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [project.project_path, onRefresh]);

  const handleUnstage = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitUnstage(project.project_path, [path]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [project.project_path, onRefresh]);

  const handleStageAll = useCallback(async () => {
    setError(null);
    try {
      await gitStage(project.project_path, ["."]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [project.project_path, onRefresh]);

  const handleUnstageAll = useCallback(async () => {
    setError(null);
    try {
      await gitUnstage(project.project_path, ["."]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [project.project_path, onRefresh]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    // 3D: Auto-stage if enabled, otherwise require staged files
    if (!autoStage && staged.length === 0) return;
    try {
      setError(null);
      // Auto-stage all if enabled
      if (autoStage) {
        await gitStage(project.project_path, ["."]);
      }
      // Read author overrides from settings
      let authorName: string | undefined;
      let authorEmail: string | undefined;
      try {
        const settings = await getSettings();
        if (settings.git_author_name) authorName = settings.git_author_name;
        if (settings.git_author_email) authorEmail = settings.git_author_email;
      } catch { /* use defaults */ }
      await gitCommit(project.project_path, commitMsg.trim(), authorName, authorEmail);
      setCommitMsg("");
      setCommitSuccess(true);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [project.project_path, commitMsg, staged.length, autoStage, onRefresh]);

  const handlePush = useCallback(async () => {
    try {
      setPushing(true);
      setError(null);
      await gitPush(project.project_path);
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setPushing(false); }
  }, [project.project_path, onRefresh]);

  const handlePull = useCallback(async () => {
    try {
      setPulling(true);
      setError(null);
      await gitPull(project.project_path);
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setPulling(false); }
  }, [project.project_path, onRefresh]);

  // 2G: Open-file with error feedback
  const handleOpen = useCallback((path: string) => {
    setError(null);
    gitOpenFile(project.project_path, path).catch((e) => setError(String(e)));
  }, [project.project_path]);

  const handleFileClick = useCallback((file: GitFile) => {
    if (file.status !== "untracked") {
      onDiffFile(project.project_path, file);
    }
  }, [project.project_path, onDiffFile]);

  const commitDisabled = autoStage
    ? !commitMsg.trim() || (staged.length === 0 && unstaged.length === 0 && untracked.length === 0)
    : staged.length === 0 || !commitMsg.trim();

  return (
    <div className="git-project-section">
      <div className="git-project-header" onClick={() => setExpanded((v) => !v)}>
        <span className={`git-project-chevron ${expanded ? "git-project-chevron-open" : ""}`}>&#9656;</span>
        <span className="git-project-name">{project.project_name}</span>
        {project.branch && <span className="git-project-branch">{project.branch}</span>}
        {totalChanges > 0 && <span className="git-project-badge">{totalChanges}</span>}
        {project.ahead > 0 && <span className="git-project-ahead" title={`${project.ahead} ahead`}>&uarr;{project.ahead}</span>}
        {project.behind > 0 && <span className="git-project-behind" title={`${project.behind} behind`}>&darr;{project.behind}</span>}
      </div>

      {expanded && (
        <div className="git-project-body">
          {project.error && (
            <div className="git-error">{project.error}</div>
          )}

          {/* Staged files */}
          {staged.length > 0 && (
            <div className="git-file-group">
              <div className="git-file-group-header">
                <span className="git-file-group-label">STAGED ({staged.length})</span>
                <button className="git-group-btn" onClick={handleUnstageAll} title="Unstage all">&minus; all</button>
              </div>
              {staged.map((f) => (
                <GitFileRow
                  key={`staged-${f.path}`}
                  file={f}
                  onUnstage={handleUnstage}
                  onOpen={handleOpen}
                  onClick={handleFileClick}
                />
              ))}
            </div>
          )}

          {/* Unstaged files */}
          {unstaged.length > 0 && (
            <div className="git-file-group">
              <div className="git-file-group-header">
                <span className="git-file-group-label">CHANGES ({unstaged.length})</span>
                <button className="git-group-btn" onClick={handleStageAll} title="Stage all">+ all</button>
              </div>
              {unstaged.map((f) => (
                <GitFileRow
                  key={`unstaged-${f.path}`}
                  file={f}
                  onStage={handleStage}
                  onOpen={handleOpen}
                  onClick={handleFileClick}
                />
              ))}
            </div>
          )}

          {/* Untracked files */}
          {untracked.length > 0 && (
            <div className="git-file-group">
              <div className="git-file-group-header">
                <span className="git-file-group-label">UNTRACKED ({untracked.length})</span>
                <button className="git-group-btn" onClick={handleStageAll} title="Stage all">+ all</button>
              </div>
              {untracked.map((f) => (
                <GitFileRow
                  key={`untracked-${f.path}`}
                  file={f}
                  onStage={handleStage}
                  onOpen={handleOpen}
                  onClick={handleFileClick}
                />
              ))}
            </div>
          )}

          {totalChanges === 0 && !project.error && (
            <div className="git-empty">No changes</div>
          )}

          {/* Commit area */}
          <div className="git-commit-area">
            <input
              className="git-commit-input"
              placeholder="Commit message..."
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleCommit();
                }
              }}
            />
            <div className="git-commit-actions">
              <button
                className="git-btn git-btn-commit"
                disabled={commitDisabled}
                onClick={handleCommit}
              >
                {autoStage ? "Stage & Commit" : "Commit"}
              </button>
              {commitSuccess && <span className="git-success">Committed!</span>}
              <button
                className="git-btn git-btn-pull"
                disabled={pulling}
                onClick={handlePull}
              >
                {pulling ? "..." : "Pull \u2193"}
              </button>
              <button
                className="git-btn git-btn-push"
                disabled={pushing}
                onClick={handlePush}
              >
                {pushing ? "..." : "Push \u2191"}
              </button>
            </div>
          </div>

          {error && (
            <div className="git-error">{error}</div>
          )}
        </div>
      )}
    </div>
  );
}
