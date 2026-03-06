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
  sessionId: string;
  realmId: string;
  project: GitProjectStatus;
  onRefresh: () => void;
  onDiffFile: (sessionId: string, realmId: string, file: GitFile) => void;
  onToast: (message: string, type?: GitToast["type"]) => void;
}

type ViewMode = "changes" | "history";

function truncatePath(fullPath: string, maxLen = 45): string {
  const home = fullPath.replace(/^\/Users\/[^/]+/, "~");
  if (home.length <= maxLen) return home;
  const parts = home.split("/");
  // Keep first and last 2 segments
  if (parts.length > 4) {
    return parts[0] + "/…/" + parts.slice(-2).join("/");
  }
  return "…" + home.slice(home.length - maxLen);
}

function isWorktreePath(path: string): boolean {
  return path.includes("/.hermes/worktrees/");
}

export function GitProjectSection({ sessionId, realmId, project, onRefresh, onDiffFile, onToast }: GitProjectSectionProps) {
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
      gitMergeStatus(sessionId, realmId)
        .then((ms) => setMergeStatus(ms))
        .catch(() => {});
    } else {
      // Also check — repo might be in merge state without conflicts yet
      gitMergeStatus(sessionId, realmId)
        .then((ms) => {
          if (ms.in_merge) setMergeStatus(ms);
          else setMergeStatus(null);
        })
        .catch(() => {});
    }
  }, [project.has_conflicts, sessionId, realmId]);

  const handleStage = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitStage(sessionId, realmId, [path]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, realmId, onRefresh]);

  const handleUnstage = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitUnstage(sessionId, realmId, [path]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, realmId, onRefresh]);

  const handleStageAll = useCallback(async () => {
    setError(null);
    try {
      await gitStage(sessionId, realmId, ["."]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, realmId, onRefresh]);

  const handleUnstageAll = useCallback(async () => {
    setError(null);
    try {
      await gitUnstage(sessionId, realmId, ["."]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, realmId, onRefresh]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    if (!autoStage && staged.length === 0) return;
    try {
      setError(null);
      if (autoStage) {
        await gitStage(sessionId, realmId, ["."]);
      }
      let authorName: string | undefined;
      let authorEmail: string | undefined;
      try {
        const settings = await getSettings();
        if (settings.git_author_name) authorName = settings.git_author_name;
        if (settings.git_author_email) authorEmail = settings.git_author_email;
      } catch { /* use defaults */ }
      await gitCommit(sessionId, realmId, commitMsg.trim(), authorName, authorEmail);
      setCommitMsg("");
      onToast("Committed successfully");
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, realmId, commitMsg, staged.length, autoStage, onRefresh, onToast]);

  const handlePush = useCallback(async () => {
    try {
      setPushing(true);
      setError(null);
      const result = await gitPush(sessionId, realmId);
      onToast(result.message || "Pushed successfully");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setPushing(false); }
  }, [sessionId, realmId, onRefresh, onToast]);

  const handlePull = useCallback(async () => {
    try {
      setPulling(true);
      setError(null);
      const result = await gitPull(sessionId, realmId);
      onToast(result.message || "Pulled successfully", "info");
      onRefresh();
      // Check if pull resulted in merge conflicts
      const ms = await gitMergeStatus(sessionId, realmId);
      if (ms.in_merge) {
        setMergeStatus(ms);
        if (ms.conflicted_files.length > 0) {
          onToast("Merge has conflicts — resolve them below", "error");
        }
      }
    } catch (e) { setError(String(e)); }
    finally { setPulling(false); }
  }, [sessionId, realmId, onRefresh, onToast]);

  const handleOpen = useCallback((path: string) => {
    setError(null);
    gitOpenFile(sessionId, realmId, path).catch((e) => setError(String(e)));
  }, [sessionId, realmId]);

  const handleFileClick = useCallback((file: GitFile) => {
    if (file.status !== "untracked") {
      onDiffFile(sessionId, realmId, file);
    }
  }, [sessionId, realmId, onDiffFile]);

  // ─── Merge handlers ──────────────────────────────────────────────

  const handleResolveConflict = useCallback(async (filePath: string, strategy: ConflictStrategy) => {
    setError(null);
    try {
      await gitResolveConflict(sessionId, realmId, filePath, strategy);
      setResolvedStrategies((prev) => ({ ...prev, [filePath]: strategy }));
      const ms = await gitMergeStatus(sessionId, realmId);
      setMergeStatus(ms);
      onRefresh();
      onToast(`Resolved ${filePath} (${strategy})`, "info");
    } catch (e) { setError(String(e)); }
  }, [sessionId, realmId, onRefresh, onToast]);

  const handleAbortMerge = useCallback(async () => {
    try {
      setAborting(true);
      setError(null);
      await gitAbortMerge(sessionId, realmId);
      setMergeStatus(null);
      setResolvedStrategies({});
      setConflictViewTarget(null);
      onToast("Merge aborted", "info");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setAborting(false); }
  }, [sessionId, realmId, onRefresh, onToast]);

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
        sessionId,
        realmId,
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
  }, [sessionId, realmId, mergeStatus, onRefresh, onToast]);

  const handleViewConflict = useCallback((filePath: string) => {
    setConflictViewTarget(filePath);
  }, []);

  const commitDisabled = autoStage
    ? !commitMsg.trim() || (staged.length === 0 && unstaged.length === 0 && untracked.length === 0)
    : staged.length === 0 || !commitMsg.trim();

  const inMerge = mergeStatus?.in_merge ?? false;
  const canCompleteMerge = inMerge && mergeStatus?.conflicted_files.length === 0;

  return (
    <div className="git-project-section" style={{ position: "relative" }}>
      <div className="git-project-header" onClick={() => setExpanded((v) => !v)} onContextMenu={(e) => showEmptyMenu(e, buildEmptyAreaMenuItems("git-section"))}>
        <span className={`git-project-chevron ${expanded ? "git-project-chevron-open" : ""}`}>&#9656;</span>
        <span className="git-project-name">{project.project_name}</span>
        {isWorktreePath(project.project_path) && (
          <span className="git-project-isolated">Isolated copy</span>
        )}
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
      {expanded && project.project_path && (
        <div className="git-project-path" title={project.project_path}>
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" className="git-project-path-icon">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7Z" />
          </svg>
          <span className="git-project-path-text">{truncatePath(project.project_path)}</span>
        </div>
      )}

      {branchSelectorOpen && (
        <GitBranchSelector
          sessionId={sessionId}
          realmId={realmId}
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
                sessionId={sessionId}
                realmId={realmId}
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
            <GitLogView sessionId={sessionId} realmId={realmId} />
          )}

          {error && (
            <div className="git-error">{error}</div>
          )}
        </div>
      )}

      {/* Conflict Viewer Modal */}
      {conflictViewTarget && (
        <GitConflictViewer
          sessionId={sessionId}
          realmId={realmId}
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
