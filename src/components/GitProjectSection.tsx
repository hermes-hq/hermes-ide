import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { useContextMenu, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";
import type { GitProjectStatus, GitFile, MergeStatus, ConflictStrategy } from "../types/git";
import {
  gitStage, gitUnstage, gitCommit, gitPush, gitPull, gitOpenFile,
  gitMergeStatus, gitResolveConflict, gitAbortMerge, gitContinueMerge,
} from "../api/git";
import { getSettings } from "../api/settings";
import { GitFileRow } from "./GitFileRow";
import { GitBranchSelector } from "./GitBranchSelector";
import { GitStashSection } from "./GitStashSection";
import { GitLogView } from "./GitLogView";
import { GitMergeBanner } from "./GitMergeBanner";
import { GitConflictViewer } from "./GitConflictViewer";
import type { GitToast } from "./GitPanel";

interface GitProjectSectionProps {
  project: GitProjectStatus;
  onRefresh: () => void;
  onDiffFile: (projectPath: string, file: GitFile) => void;
  onToast: (message: string, type?: GitToast["type"]) => void;
}

type ViewMode = "changes" | "history";

export function GitProjectSection({ project, onRefresh, onDiffFile, onToast }: GitProjectSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const [commitMsg, setCommitMsg] = useState("");
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoStage, setAutoStage] = useState(false);
  const [branchSelectorOpen, setBranchSelectorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("changes");
  const branchTriggerRef = useRef<HTMLSpanElement>(null);

  // Merge state
  const [mergeStatus, setMergeStatus] = useState<MergeStatus | null>(null);
  const [aborting, setAborting] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [conflictViewTarget, setConflictViewTarget] = useState<string | null>(null);
  const [, setResolvedStrategies] = useState<Record<string, string>>({});

  const { onContextMenu: textContextMenu } = useTextContextMenu();

  const handleEmptyAreaAction = useCallback((_actionId: string) => {
    // Empty area actions (refresh, etc.)
  }, []);
  const { showMenu: showEmptyMenu } = useContextMenu(handleEmptyAreaAction);

  const staged = useMemo(() => project.files.filter((f) => f.area === "staged"), [project.files]);
  const unstaged = useMemo(() => project.files.filter((f) => f.area === "unstaged"), [project.files]);
  const untracked = useMemo(() => project.files.filter((f) => f.area === "untracked"), [project.files]);

  const totalChanges = project.files.length;
  const hasChanges = staged.length > 0 || unstaged.length > 0 || untracked.length > 0;

  // Load auto-stage setting
  useEffect(() => {
    getSettings().then((s) => {
      setAutoStage(s.git_auto_stage === "true");
    }).catch(() => {});
  }, []);

  // Auto-dismiss errors after 8 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  // Check merge status on mount and when has_conflicts changes
  useEffect(() => {
    if (project.has_conflicts) {
      gitMergeStatus(project.project_path)
        .then((ms) => setMergeStatus(ms))
        .catch(() => {});
    } else {
      // Also check — repo might be in merge state without conflicts yet
      gitMergeStatus(project.project_path)
        .then((ms) => {
          if (ms.in_merge) setMergeStatus(ms);
          else setMergeStatus(null);
        })
        .catch(() => {});
    }
  }, [project.has_conflicts, project.project_path]);

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
    if (!autoStage && staged.length === 0) return;
    try {
      setError(null);
      if (autoStage) {
        await gitStage(project.project_path, ["."]);
      }
      let authorName: string | undefined;
      let authorEmail: string | undefined;
      try {
        const settings = await getSettings();
        if (settings.git_author_name) authorName = settings.git_author_name;
        if (settings.git_author_email) authorEmail = settings.git_author_email;
      } catch { /* use defaults */ }
      await gitCommit(project.project_path, commitMsg.trim(), authorName, authorEmail);
      setCommitMsg("");
      onToast("Committed successfully");
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [project.project_path, commitMsg, staged.length, autoStage, onRefresh, onToast]);

  const handlePush = useCallback(async () => {
    try {
      setPushing(true);
      setError(null);
      const result = await gitPush(project.project_path);
      onToast(result.message || "Pushed successfully");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setPushing(false); }
  }, [project.project_path, onRefresh, onToast]);

  const handlePull = useCallback(async () => {
    try {
      setPulling(true);
      setError(null);
      const result = await gitPull(project.project_path);
      onToast(result.message || "Pulled successfully", "info");
      onRefresh();
      // Check if pull resulted in merge conflicts
      const ms = await gitMergeStatus(project.project_path);
      if (ms.in_merge) {
        setMergeStatus(ms);
        if (ms.conflicted_files.length > 0) {
          onToast("Merge has conflicts — resolve them below", "error");
        }
      }
    } catch (e) { setError(String(e)); }
    finally { setPulling(false); }
  }, [project.project_path, onRefresh, onToast]);

  const handleOpen = useCallback((path: string) => {
    setError(null);
    gitOpenFile(project.project_path, path).catch((e) => setError(String(e)));
  }, [project.project_path]);

  const handleFileClick = useCallback((file: GitFile) => {
    if (file.status !== "untracked") {
      onDiffFile(project.project_path, file);
    }
  }, [project.project_path, onDiffFile]);

  // ─── Merge handlers ──────────────────────────────────────────────

  const handleResolveConflict = useCallback(async (filePath: string, strategy: ConflictStrategy) => {
    setError(null);
    try {
      await gitResolveConflict(project.project_path, filePath, strategy);
      setResolvedStrategies((prev) => ({ ...prev, [filePath]: strategy }));
      const ms = await gitMergeStatus(project.project_path);
      setMergeStatus(ms);
      onRefresh();
      onToast(`Resolved ${filePath} (${strategy})`, "info");
    } catch (e) { setError(String(e)); }
  }, [project.project_path, onRefresh, onToast]);

  const handleAbortMerge = useCallback(async () => {
    try {
      setAborting(true);
      setError(null);
      await gitAbortMerge(project.project_path);
      setMergeStatus(null);
      setResolvedStrategies({});
      setConflictViewTarget(null);
      onToast("Merge aborted", "info");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setAborting(false); }
  }, [project.project_path, onRefresh, onToast]);

  const handleCompleteMerge = useCallback(async () => {
    try {
      setCompleting(true);
      setError(null);
      let authorName: string | undefined;
      let authorEmail: string | undefined;
      try {
        const settings = await getSettings();
        if (settings.git_author_name) authorName = settings.git_author_name;
        if (settings.git_author_email) authorEmail = settings.git_author_email;
      } catch { /* use defaults */ }
      await gitContinueMerge(
        project.project_path,
        mergeStatus?.merge_message || undefined,
        authorName,
        authorEmail,
      );
      setMergeStatus(null);
      setResolvedStrategies({});
      onToast("Merge completed");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setCompleting(false); }
  }, [project.project_path, mergeStatus, onRefresh, onToast]);

  const handleViewConflict = useCallback((filePath: string) => {
    setConflictViewTarget(filePath);
  }, []);

  const commitDisabled = autoStage
    ? !commitMsg.trim() || (staged.length === 0 && unstaged.length === 0 && untracked.length === 0)
    : staged.length === 0 || !commitMsg.trim();

  const inMerge = mergeStatus?.in_merge ?? false;
  const canCompleteMerge = inMerge && mergeStatus!.conflicted_files.length === 0;

  return (
    <div className="git-project-section" style={{ position: "relative" }}>
      <div className="git-project-header" onClick={() => setExpanded((v) => !v)} onContextMenu={(e) => showEmptyMenu(e, buildEmptyAreaMenuItems("git-section"))}>
        <span className={`git-project-chevron ${expanded ? "git-project-chevron-open" : ""}`}>&#9656;</span>
        <span className="git-project-name">{project.project_name}</span>
        {project.branch && (
          <span
            ref={branchTriggerRef}
            className="git-project-branch git-project-branch-clickable"
            onClick={(e) => { e.stopPropagation(); setBranchSelectorOpen((v) => !v); }}
            title="Switch branch"
          >
            {project.branch}
          </span>
        )}
        {totalChanges > 0 && <span className="git-project-badge">{totalChanges}</span>}
        {project.stash_count > 0 && (
          <span className="git-stash-badge" title={`${project.stash_count} stash(es)`}>
            S{project.stash_count}
          </span>
        )}
        {project.ahead > 0 && <span className="git-project-ahead" title={`${project.ahead} ahead`}>&uarr;{project.ahead}</span>}
        {project.behind > 0 && <span className="git-project-behind" title={`${project.behind} behind`}>&darr;{project.behind}</span>}
      </div>

      {branchSelectorOpen && (
        <GitBranchSelector
          projectPath={project.project_path}
          currentBranch={project.branch}
          onRefresh={onRefresh}
          onToast={onToast}
          onClose={() => setBranchSelectorOpen(false)}
          triggerRef={branchTriggerRef}
        />
      )}

      {expanded && (
        <div className="git-project-body">
          {project.error && (
            <div className="git-error">{project.error}</div>
          )}

          {/* View Toggle: Changes | History */}
          <div className="git-view-toggle">
            <button
              className={`git-view-toggle-btn ${viewMode === "changes" ? "git-view-toggle-btn-active" : ""}`}
              onClick={() => setViewMode("changes")}
            >
              Changes
            </button>
            <button
              className={`git-view-toggle-btn ${viewMode === "history" ? "git-view-toggle-btn-active" : ""}`}
              onClick={() => setViewMode("history")}
            >
              History
            </button>
          </div>

          {viewMode === "changes" && (
            <>
              {/* Merge Banner */}
              {inMerge && mergeStatus && (
                <GitMergeBanner
                  mergeStatus={mergeStatus}
                  projectPath={project.project_path}
                  onResolve={handleResolveConflict}
                  onViewConflict={handleViewConflict}
                  onAbort={handleAbortMerge}
                  aborting={aborting}
                />
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

              {totalChanges === 0 && !project.error && !inMerge && (
                <div className="git-empty">No changes</div>
              )}

              {/* Stash Section */}
              <GitStashSection
                projectPath={project.project_path}
                stashCount={project.stash_count}
                hasChanges={hasChanges}
                onRefresh={onRefresh}
                onToast={onToast}
              />

              {/* Commit / Merge Actions */}
              {inMerge ? (
                <div className="git-commit-area">
                  <div className="git-merge-message">
                    {mergeStatus?.merge_message || "Merge in progress"}
                  </div>
                  <div className="git-merge-actions">
                    <button
                      className="git-btn git-btn-merge-complete"
                      disabled={!canCompleteMerge || completing}
                      onClick={handleCompleteMerge}
                    >
                      {completing ? "..." : "Complete Merge"}
                    </button>
                    <button
                      className="git-btn git-btn-merge-abort"
                      disabled={aborting}
                      onClick={handleAbortMerge}
                    >
                      {aborting ? "..." : "Abort Merge"}
                    </button>
                  </div>
                </div>
              ) : (
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
                    onContextMenu={textContextMenu}
                  />
                  <div className="git-commit-actions">
                    <button
                      className="git-btn git-btn-commit"
                      disabled={commitDisabled}
                      onClick={handleCommit}
                    >
                      {autoStage ? "Stage & Commit" : "Commit"}
                    </button>
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
              )}
            </>
          )}

          {viewMode === "history" && (
            <GitLogView projectPath={project.project_path} />
          )}

          {error && (
            <div className="git-error">{error}</div>
          )}
        </div>
      )}

      {/* Conflict Viewer Modal */}
      {conflictViewTarget && (
        <GitConflictViewer
          projectPath={project.project_path}
          filePath={conflictViewTarget}
          onResolve={(filePath, strategy) => {
            handleResolveConflict(filePath, strategy);
            setConflictViewTarget(null);
          }}
          onClose={() => setConflictViewTarget(null)}
        />
      )}
    </div>
  );
}
