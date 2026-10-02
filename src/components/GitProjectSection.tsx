import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useTextContextMenu } from "../hooks/useTextContextMenu";
import { useContextMenu, buildEmptyAreaMenuItems } from "../hooks/useContextMenu";
import type { GitProjectStatus, GitFile, MergeStatus, ConflictStrategy } from "../types/git";
import {
  gitStage, gitUnstage, gitDiscardChanges, gitCommit, gitPush, gitPull, gitOpenFile,
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
import { GitActionButton } from "./GitActionButton";
import { Textarea } from "./ui/Input";
import { friendlyWorktreeLabel, isHermesWorktreePath } from "../utils/worktree";
import { parseHookRefusal } from "../utils/gitErrors";
import { translate } from "../i18n/registry";
import { useOptionalSessions } from "../state/sessionContextObject";
import { agentDisplayName, getAgent } from "../catalog/agentCatalog";
import { Button } from "./ui";
import { translatePlural } from "../i18n/plural";

interface GitProjectSectionProps {
  sessionId: string;
  projectId: string;
  project: GitProjectStatus;
  onRefresh: () => void;
  onDiffFile: (sessionId: string, projectId: string, file: GitFile) => void;
  onToast: (message: string, type?: GitToast["type"]) => void;
  /**
   * "changes": the Review Desk's Changes section (reviewDesk flag), where
   * history and stash live in the Repository tab instead: no History toggle,
   * no stash list, no folder line. Default "panel": the git panel as it was.
   */
  variant?: "panel" | "changes";
  /** A commit message to start from (drafted from the turns); the person's own text is never replaced. */
  draftMessage?: string;
  /** A label above the commit message box ("changes" variant). */
  commitLabel?: string;
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
  return isHermesWorktreePath(path);
}

export { friendlyWorktreeLabel };

export function GitProjectSection({ sessionId, projectId, project, onRefresh, onDiffFile, onToast, variant = "panel", draftMessage, commitLabel }: GitProjectSectionProps) {
  const changesOnly = variant === "changes";
  const [expanded, setExpanded] = useState(true);
  const [commitMsg, setCommitMsg] = useState(draftMessage ?? "");
  // A new draft replaces the message only while the person has not typed
  // one; after a commit the box stays empty until the draft changes.
  const draftApplied = useRef(draftMessage ?? "");
  const edited = useRef(false);
  useEffect(() => {
    if (!draftMessage || draftMessage === draftApplied.current) return;
    draftApplied.current = draftMessage;
    if (!edited.current) setCommitMsg(draftMessage);
  }, [draftMessage]);
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
  /** "Abort the merge?" is showing. */
  const [confirmAbort, setConfirmAbort] = useState(false);
  // translate, not useI18n: also rendered outside the I18n provider (panel tests).
  const t = translate;

  // A task's isolated worktree, or a folder an agent works in: switching its
  // branch moves the agent's next commits (and Land), so the switcher asks.
  const session = useOptionalSessions()?.[sessionId];
  const agentName = session ? agentDisplayName(session) ?? getAgent(session.ai_provider)?.name ?? null : null;
  const agentRunning = !!session && session.phase !== "destroyed" && (!!session.detected_agent || !!session.ai_provider);
  const confirmSwitch: "task-worktree" | "agent-folder" | null = isWorktreePath(project.project_path)
    ? "task-worktree"
    : agentRunning ? "agent-folder" : null;

  const { onContextMenu: textContextMenu } = useTextContextMenu();

  const handleEmptyAreaAction = useCallback((_actionId: string) => {
    // Empty area actions (refresh, etc.)
  }, []);
  const { showMenu: showEmptyMenu } = useContextMenu(handleEmptyAreaAction);

  const staged = useMemo(() => project.files.filter((f) => f.area === "staged"), [project.files]);
  // In the Review Desk a Feature Track's planning files (.hermes/features/)
  // are a collapsed group of their own, which "+ all" leaves out: they are
  // archived by Land, not committed with the code.
  const isTrackFile = useCallback((path: string) => changesOnly && path.replace(/\\/g, "/").startsWith(".hermes/features/"), [changesOnly]);
  const trackFiles = useMemo(() => project.files.filter((f) => f.area !== "staged" && isTrackFile(f.path)), [project.files, isTrackFile]);
  const [trackFilesOpen, setTrackFilesOpen] = useState(false);
  const unstaged = useMemo(() => project.files.filter((f) => f.area === "unstaged" && !isTrackFile(f.path)), [project.files, isTrackFile]);
  const untracked = useMemo(() => project.files.filter((f) => f.area === "untracked" && !isTrackFile(f.path)), [project.files, isTrackFile]);

  const totalChanges = project.files.length;
  const hasChanges = staged.length > 0 || unstaged.length > 0 || untracked.length > 0 || trackFiles.length > 0;

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
      gitMergeStatus(sessionId, projectId)
        .then((ms) => setMergeStatus(ms))
        .catch(() => {});
    } else {
      // Also check — repo might be in merge state without conflicts yet
      gitMergeStatus(sessionId, projectId)
        .then((ms) => {
          if (ms.in_merge) setMergeStatus(ms);
          else setMergeStatus(null);
        })
        .catch(() => {});
    }
  }, [project.has_conflicts, sessionId, projectId]);

  const handleStage = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitStage(sessionId, projectId, [path]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, projectId, onRefresh]);

  const handleUnstage = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitUnstage(sessionId, projectId, [path]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, projectId, onRefresh]);

  const handleDiscard = useCallback(async (path: string) => {
    setError(null);
    try {
      await gitDiscardChanges(sessionId, projectId, [path]);
      onRefresh();
      // Notify file editor to reload if this file is open
      window.dispatchEvent(new CustomEvent("hermes:file-changed-on-disk", { detail: { projectId, filePath: path } }));
    } catch (e) { setError(String(e)); }
  }, [sessionId, projectId, onRefresh]);

  const handleStageAll = useCallback(async () => {
    setError(null);
    try {
      // The Review Desk stages what its lists show, never the track's files.
      const paths = changesOnly ? [...unstaged, ...untracked].map((f) => f.path) : ["."];
      if (paths.length === 0) return;
      await gitStage(sessionId, projectId, paths);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, projectId, onRefresh, changesOnly, unstaged, untracked]);

  const handleUnstageAll = useCallback(async () => {
    setError(null);
    try {
      await gitUnstage(sessionId, projectId, ["."]);
      onRefresh();
    } catch (e) { setError(String(e)); }
  }, [sessionId, projectId, onRefresh]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    if (!autoStage && staged.length === 0) return;
    try {
      setError(null);
      if (autoStage) {
        await gitStage(sessionId, projectId, ["."]);
      }
      let authorName: string | undefined;
      let authorEmail: string | undefined;
      try {
        const settings = await getSettings();
        if (settings.git_author_name) authorName = settings.git_author_name;
        if (settings.git_author_email) authorEmail = settings.git_author_email;
      } catch { /* use defaults */ }
      await gitCommit(sessionId, projectId, commitMsg.trim(), authorName, authorEmail);
      setCommitMsg("");
      edited.current = false;
      onToast("Committed successfully");
      onRefresh();
    } catch (e) {
      // The repository's hook said no: show what it printed, as it printed it.
      const hook = parseHookRefusal(e);
      setError(hook ? t("dirty.hookRefused", { hook: hook.hook, output: hook.output }) : String(e));
    }
  }, [sessionId, projectId, commitMsg, staged.length, autoStage, onRefresh, onToast, t]);

  const handlePush = useCallback(async () => {
    try {
      setPushing(true);
      setError(null);
      const result = await gitPush(sessionId, projectId);
      onToast(result.message || "Pushed successfully");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setPushing(false); }
  }, [sessionId, projectId, onRefresh, onToast]);

  const handlePull = useCallback(async () => {
    try {
      setPulling(true);
      setError(null);
      const result = await gitPull(sessionId, projectId);
      onToast(result.message || "Pulled successfully", "info");
      onRefresh();
      // Check if pull resulted in merge conflicts
      const ms = await gitMergeStatus(sessionId, projectId);
      if (ms.in_merge) {
        setMergeStatus(ms);
        if (ms.conflicted_files.length > 0) {
          onToast("Merge has conflicts — resolve them below", "error");
        }
      }
    } catch (e) { setError(String(e)); }
    finally { setPulling(false); }
  }, [sessionId, projectId, onRefresh, onToast]);

  const handleOpen = useCallback((path: string) => {
    setError(null);
    gitOpenFile(sessionId, projectId, path).catch((e) => setError(String(e)));
  }, [sessionId, projectId]);

  const handleFileClick = useCallback((file: GitFile) => {
    if (file.status !== "untracked") {
      onDiffFile(sessionId, projectId, file);
    }
  }, [sessionId, projectId, onDiffFile]);

  // ─── Merge handlers ──────────────────────────────────────────────

  const handleResolveConflict = useCallback(async (filePath: string, strategy: ConflictStrategy) => {
    setError(null);
    try {
      await gitResolveConflict(sessionId, projectId, filePath, strategy);
      setResolvedStrategies((prev) => ({ ...prev, [filePath]: strategy }));
      const ms = await gitMergeStatus(sessionId, projectId);
      setMergeStatus(ms);
      onRefresh();
      onToast(`Resolved ${filePath} (${strategy})`, "info");
    } catch (e) { setError(String(e)); }
  }, [sessionId, projectId, onRefresh, onToast]);

  /** Abort asks first: it puts back the files the merge changed. */
  const requestAbortMerge = useCallback(() => {
    setError(null);
    setConfirmAbort(true);
  }, []);

  const handleAbortMerge = useCallback(async () => {
    try {
      setConfirmAbort(false);
      setAborting(true);
      setError(null);
      await gitAbortMerge(sessionId, projectId);
      setMergeStatus(null);
      setResolvedStrategies({});
      setConflictViewTarget(null);
      onToast("Merge aborted", "info");
      onRefresh();
    } catch (e) { setError(String(e)); }
    finally { setAborting(false); }
  }, [sessionId, projectId, onRefresh, onToast]);

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
        projectId,
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
  }, [sessionId, projectId, mergeStatus, onRefresh, onToast]);

  const handleViewConflict = useCallback((filePath: string) => {
    setConflictViewTarget(filePath);
  }, []);

  const commitDisabled = autoStage
    ? !commitMsg.trim() || (staged.length === 0 && unstaged.length === 0 && untracked.length === 0)
    : staged.length === 0 || !commitMsg.trim();

  const inMerge = mergeStatus?.in_merge ?? false;
  const canCompleteMerge = inMerge && mergeStatus?.conflicted_files.length === 0;

  return (
    <div className="git-project-section" style={{ position: "relative" }} data-project-id={projectId} data-branch={project.branch ?? ""} data-variant={variant}>
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
      {expanded && !changesOnly && project.project_path && (
        <div className="git-project-path" title={isWorktreePath(project.project_path) ? friendlyWorktreeLabel(project.project_name, project.project_path) : project.project_path}>
          <svg viewBox="0 0 16 16" fill="currentColor" width="12" height="12" className="git-project-path-icon">
            <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2c-.33-.44-.85-.7-1.4-.7Z" />
          </svg>
          <span className="git-project-path-text">
            {isWorktreePath(project.project_path)
              ? friendlyWorktreeLabel(project.project_name, project.project_path)
              : truncatePath(project.project_path)}
          </span>
        </div>
      )}

      {branchSelectorOpen && (
        <GitBranchSelector
          sessionId={sessionId}
          projectId={projectId}
          currentBranch={project.branch}
          onRefresh={onRefresh}
          onToast={onToast}
          onClose={() => setBranchSelectorOpen(false)}
          triggerRef={branchTriggerRef}
          confirmSwitch={confirmSwitch}
          agentName={agentName}
        />
      )}

      {expanded && (
        <div className="git-project-body">
          {project.error && (
            <div className="git-error">{project.error}</div>
          )}

          {/* View Toggle: Changes | History (the Review Desk keeps history in its Repository tab) */}
          {!changesOnly && (
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
          )}

          {viewMode === "changes" && (
            <>
              {/* Merge Banner */}
              {inMerge && mergeStatus && (
                <GitMergeBanner
                  mergeStatus={mergeStatus}
                  onResolve={handleResolveConflict}
                  onViewConflict={handleViewConflict}
                  onAbort={() => void handleAbortMerge()}
                  aborting={aborting}
                />
              )}

              {inMerge && confirmAbort && (
                <div className="git-branch-ask git-abort-confirm" role="alertdialog" aria-labelledby={`git-abort-text-${projectId}`}>
                  <div className="git-branch-ask-text" id={`git-abort-text-${projectId}`}>
                    {t("merge.abortConfirm")}
                  </div>
                  <div className="git-branch-ask-actions">
                    <Button size="sm" className="git-abort-cancel" onClick={() => setConfirmAbort(false)}>
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" variant="danger" className="git-abort-yes" onClick={() => void handleAbortMerge()}>
                      {t("merge.abortYes")}
                    </Button>
                  </div>
                </div>
              )}

              {/* Staged files */}
              {staged.length > 0 && (
                <div className="git-file-group">
                  <div className="git-file-group-header">
                    <span className="git-file-group-label">STAGED ({staged.length})</span>
                    <GitActionButton kit={changesOnly} variant="quiet" kitClass="git-group-action" legacyClass="git-group-btn" onClick={handleUnstageAll} title="Unstage all">{"\u2212 all"}</GitActionButton>
                  </div>
                  {staged.map((f) => (
                    <GitFileRow
                      key={`staged-${f.path}`}
                      file={f}
                      onUnstage={handleUnstage}
                      onOpen={handleOpen}
                      onClick={handleFileClick}
                      kit={changesOnly}
                    />
                  ))}
                </div>
              )}

              {/* Unstaged files */}
              {unstaged.length > 0 && (
                <div className="git-file-group">
                  <div className="git-file-group-header">
                    <span className="git-file-group-label">CHANGES ({unstaged.length})</span>
                    <GitActionButton kit={changesOnly} variant="quiet" kitClass="git-group-action" legacyClass="git-group-btn" onClick={handleStageAll} title="Stage all">+ all</GitActionButton>
                  </div>
                  {unstaged.map((f) => (
                    <GitFileRow
                      key={`unstaged-${f.path}`}
                      file={f}
                      onStage={handleStage}
                      onDiscard={handleDiscard}
                      onOpen={handleOpen}
                      onClick={handleFileClick}
                      kit={changesOnly}
                    />
                  ))}
                </div>
              )}

              {/* Untracked files */}
              {untracked.length > 0 && (
                <div className="git-file-group">
                  <div className="git-file-group-header">
                    <span className="git-file-group-label">UNTRACKED ({untracked.length})</span>
                    <GitActionButton kit={changesOnly} variant="quiet" kitClass="git-group-action" legacyClass="git-group-btn" onClick={handleStageAll} title="Stage all">+ all</GitActionButton>
                  </div>
                  {untracked.map((f) => (
                    <GitFileRow
                      key={`untracked-${f.path}`}
                      file={f}
                      onStage={handleStage}
                      onOpen={handleOpen}
                      onClick={handleFileClick}
                      kit={changesOnly}
                    />
                  ))}
                </div>
              )}

              {/* A Feature Track's planning files: collapsed, left out of "+ all". */}
              {trackFiles.length > 0 && (
                <div className="git-file-group git-track-files" data-count={trackFiles.length} data-open={trackFilesOpen ? "1" : "0"}>
                  <div className="git-file-group-header">
                    <Button size="sm" variant="quiet" className="git-track-toggle" aria-expanded={trackFilesOpen} onClick={() => setTrackFilesOpen((o) => !o)}>
                      <span aria-hidden="true">{trackFilesOpen ? "\u25BE" : "\u25B8"}</span> {translatePlural("review.trackFiles", trackFiles.length)}
                    </Button>
                  </div>
                  {trackFilesOpen && trackFiles.map((f) => (
                    <GitFileRow
                      key={`track-${f.area}-${f.path}`}
                      file={f}
                      onStage={handleStage}
                      onDiscard={handleDiscard}
                      onOpen={handleOpen}
                      onClick={handleFileClick}
                      kit={changesOnly}
                    />
                  ))}
                </div>
              )}

              {totalChanges === 0 && !project.error && !inMerge && (
                <div className="git-empty">No changes</div>
              )}

              {/* Stash Section (the Review Desk has it in its Repository tab) */}
              {!changesOnly && (
                <GitStashSection
                  sessionId={sessionId}
                  projectId={projectId}
                  stashCount={project.stash_count}
                  hasChanges={hasChanges}
                  onRefresh={onRefresh}
                  onToast={onToast}
                />
              )}

              {/* Commit / Merge Actions */}
              {inMerge ? (
                <div className="git-commit-area">
                  <div className="git-merge-message">
                    {mergeStatus?.merge_message || "Merge in progress"}
                  </div>
                  <div className="git-merge-actions">
                    <GitActionButton
                      kit={changesOnly}
                      variant="primary"
                      kitClass="git-merge-complete"
                      legacyClass="git-btn git-btn-merge-complete"
                      disabled={!canCompleteMerge || completing}
                      onClick={handleCompleteMerge}
                    >
                      {completing ? "..." : "Complete Merge"}
                    </GitActionButton>
                    <GitActionButton
                      kit={changesOnly}
                      variant="danger"
                      kitClass="git-merge-abort"
                      legacyClass="git-btn git-btn-merge-abort"
                      disabled={aborting}
                      onClick={requestAbortMerge}
                    >
                      {aborting ? "..." : "Abort Merge"}
                    </GitActionButton>
                  </div>
                </div>
              ) : (
                <div className="git-commit-area">
                  {changesOnly ? (
                    <>
                      {commitLabel && (
                        <label className="git-commit-label" htmlFor={`git-commit-${projectId}`}>
                          {commitLabel}
                        </label>
                      )}
                      {/* Several lines: the drafted message lists the turns. */}
                      <Textarea
                        id={`git-commit-${projectId}`}
                        className="git-commit-textarea"
                        placeholder="Commit message..."
                        rows={3}
                        value={commitMsg}
                        onChange={(e) => {
                          edited.current = true;
                          setCommitMsg(e.target.value);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            handleCommit();
                          }
                        }}
                        onContextMenu={textContextMenu}
                      />
                    </>
                  ) : (
                  <input
                    className="git-commit-input"
                    placeholder="Commit message..."
                    value={commitMsg}
                    onChange={(e) => {
                      edited.current = true;
                      setCommitMsg(e.target.value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleCommit();
                      }
                    }}
                    onContextMenu={textContextMenu}
                  />
                  )}
                  <div className="git-commit-actions">
                    <GitActionButton
                      kit={changesOnly}
                      variant="primary"
                      kitClass="git-btn-commit"
                      legacyClass="git-btn git-btn-commit"
                      disabled={commitDisabled}
                      onClick={handleCommit}
                    >
                      {autoStage ? "Stage & Commit" : "Commit"}
                    </GitActionButton>
                    <GitActionButton kit={changesOnly} kitClass="git-btn-pull" legacyClass="git-btn git-btn-pull" disabled={pulling} onClick={handlePull}>
                      {pulling ? "..." : "Pull \u2193"}
                    </GitActionButton>
                    <GitActionButton kit={changesOnly} kitClass="git-btn-push" legacyClass="git-btn git-btn-push" disabled={pushing} onClick={handlePush}>
                      {pushing ? "..." : "Push \u2191"}
                    </GitActionButton>
                  </div>
                </div>
              )}
            </>
          )}

          {viewMode === "history" && (
            <GitLogView sessionId={sessionId} projectId={projectId} />
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
          projectId={projectId}
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
