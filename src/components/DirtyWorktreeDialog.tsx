import { useState, useEffect, useCallback, useRef } from "react";
import "../styles/components/DirtyWorktreeDialog.css";
import { Button, CloseButton } from "./ui";
import { translate } from "../i18n/registry";

export interface DirtyWorktreeChange {
  projectId: string;
  projectName: string;
  /** The branch Hermes recorded for the task's worktree. */
  branchName: string | null;
  files: Array<{ path: string; status: string }>;
  /** The branch HEAD is really on (null: detached, or unknown). */
  actualBranch?: string | null;
  detached?: boolean;
  /** Commits on a detached HEAD that no branch, tag or remote branch has. */
  lostCommits?: number;
  /** An operation in progress: rebase, merge, bisect, cherry-pick, revert. */
  operation?: string | null;
  /** Submodules with uncommitted changes inside them. */
  dirtySubmodules?: string[];
  /** The check itself failed (the worktree is never deleted unasked then). */
  checkError?: string | null;
}

export interface StashError {
  projectName: string;
  error: string;
}

interface DirtyWorktreeDialogProps {
  sessionId: string;
  sessionLabel: string;
  changes: DirtyWorktreeChange[];
  stashErrors?: StashError[];
  /**
   * "stash" (default): the old Stash & Close. "commit" (flag
   * `honestIsolation`): Commit to session branch & close, or Archive (keep
   * branch). Neither of those touches the stash.
   */
  variant?: "stash" | "commit";
  /** The session's program was running: it is stopped before anything is saved. */
  agentWorking?: boolean;
  /** The session already stopped; its worktrees wait on disk to be saved. */
  closed?: boolean;
  keptPaths?: Record<string, string>;
  /** A commit hook refused the commit. */
  hookRefusal?: { projectName: string; hook: string; output: string } | null;
  onStashAndClose: () => Promise<void> | void;
  onCommitAndClose?: () => Promise<void> | void;
  onArchiveAndClose?: () => Promise<void> | void;
  onSaveDetachedAndClose?: () => Promise<void> | void;
  onKeepAndClose?: () => Promise<void> | void;
  onCloseAnyway: () => void;
  onCancel: () => void;
}

function statusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === "MODIFIED" || s === "M") return "M";
  if (s === "ADDED" || s === "A" || s === "NEW" || s === "UNTRACKED") return "A";
  if (s === "DELETED" || s === "D") return "D";
  if (s === "RENAMED" || s === "R") return "R";
  return s.charAt(0) || "?";
}

function statusClass(status: string): string {
  const label = statusLabel(status);
  switch (label) {
    case "M": return "dirty-wt-file-status--modified";
    case "A": return "dirty-wt-file-status--added";
    case "D": return "dirty-wt-file-status--deleted";
    default: return "dirty-wt-file-status--unknown";
  }
}

export function groupFilesByStatus(
  files: Array<{ path: string; status: string }>,
): { modified: number; added: number; deleted: number; other: number } {
  let modified = 0;
  let added = 0;
  let deleted = 0;
  let other = 0;
  for (const file of files) {
    const label = statusLabel(file.status);
    if (label === "M") modified++;
    else if (label === "A") added++;
    else if (label === "D") deleted++;
    else other++;
  }
  return { modified, added, deleted, other };
}

type Translate = (key: string, values?: Record<string, string | number>) => string;
const english: Translate = (key, values = {}) => {
  const words: Record<string, string> = {
    "dirty.breakdownModified": "{count} modified",
    "dirty.breakdownNew": "{count} new",
    "dirty.breakdownDeleted": "{count} deleted",
    "dirty.breakdownOther": "{count} other",
  };
  return (words[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));
};

export function formatFileBreakdown(
  files: Array<{ path: string; status: string }>,
  t: Translate = english,
): string {
  const { modified, added, deleted, other } = groupFilesByStatus(files);
  const parts: string[] = [];
  if (modified > 0) parts.push(t("dirty.breakdownModified", { count: modified }));
  if (added > 0) parts.push(t("dirty.breakdownNew", { count: added }));
  if (deleted > 0) parts.push(t("dirty.breakdownDeleted", { count: deleted }));
  if (other > 0) parts.push(t("dirty.breakdownOther", { count: other }));
  return parts.join(", ");
}

/** The archive branch a detached HEAD is saved on (the backend may add -2, -3…). */
export function detachedArchiveBranch(recorded: string | null): string {
  const stem = (recorded ?? "task").replace(/^hermes\//, "");
  return `hermes-archive/${stem}-detached`;
}

/** Which question the dialog asks first, from what the close check found. */
export type DirtyCloseMode = "check-failed" | "hook-refused" | "detached" | "changes" | "keep-only";

export function dirtyCloseMode(changes: readonly DirtyWorktreeChange[], hookRefused: boolean): DirtyCloseMode {
  if (hookRefused) return "hook-refused";
  if (changes.some((c) => c.checkError)) return "check-failed";
  if (changes.some((c) => c.detached && ((c.lostCommits ?? 0) > 0 || c.files.length > 0))) return "detached";
  if (changes.some((c) => c.files.length > 0)) return "changes";
  return "keep-only";
}

/** The branch the commit button names: the one HEAD is really on when it moved. */
export function commitBranchLabel(changes: readonly DirtyWorktreeChange[]): { branch: string; switchedFrom: string } | null {
  const moved = changes.find((c) => c.files.length > 0 && c.actualBranch && c.branchName && c.actualBranch !== c.branchName);
  return moved ? { branch: moved.actualBranch!, switchedFrom: moved.branchName! } : null;
}

export function DirtyWorktreeDialog({
  sessionLabel,
  changes,
  stashErrors,
  variant = "stash",
  agentWorking,
  closed,
  keptPaths,
  hookRefusal,
  onStashAndClose,
  onCommitAndClose,
  onArchiveAndClose,
  onSaveDetachedAndClose,
  onKeepAndClose,
  onCloseAnyway,
  onCancel,
}: DirtyWorktreeDialogProps) {
  // translate, not useI18n: also rendered outside the I18n provider (panel tests).
  const t = translate;
  const modalRef = useRef<HTMLDivElement>(null);
  const [stashing, setStashing] = useState(false);
  const committing = variant === "commit";
  const mode = dirtyCloseMode(changes, !!hookRefusal);
  const moved = commitBranchLabel(changes);

  const runBusy = useCallback(async (action: (() => Promise<void> | void) | undefined) => {
    if (!action) return;
    setStashing(true);
    try {
      await action();
    } finally {
      setStashing(false);
    }
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (stashing) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }

    // Focus trapping within the dialog
    if (e.key === "Tab" && modalRef.current) {
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }, [onCancel, stashing]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Focus the first button (Cancel) on mount
  useEffect(() => {
    if (modalRef.current) {
      const firstBtn = modalRef.current.querySelector<HTMLElement>("button");
      firstBtn?.focus();
    }
  }, []);

  const allFiles = changes.flatMap((c) => c.files);
  const breakdown = formatFileBreakdown(allFiles, t);
  const detachedTarget = changes.find((c) => c.detached && ((c.lostCommits ?? 0) > 0 || c.files.length > 0));
  const anySubmodule = changes.some((c) => (c.dirtySubmodules?.length ?? 0) > 0);
  const busyLabel = committing ? t("dirty.saving") : t("dirty.stashing");

  const cancel = (
    <Button className="dirty-wt-btn-cancel" onClick={onCancel} disabled={stashing}>
      {t("common.cancel")}
    </Button>
  );

  return (
    <div className="dirty-wt-overlay" onClick={stashing ? undefined : onCancel}>
      <div
        className="dirty-wt-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dirty-wt-dialog-title"
        data-mode={mode}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="dirty-wt-header">
          <span className="dirty-wt-icon">&#9888;</span>
          <span className="dirty-wt-title" id="dirty-wt-dialog-title">{t("dirty.title")}</span>
          <CloseButton className="dirty-wt-close" onClick={onCancel} disabled={stashing} label={t("common.close")} />
        </div>

        {/* Body */}
        <div className="dirty-wt-body">
          {allFiles.length > 0 && (
            <p className="dirty-wt-message">
              {t("dirty.summary", { label: sessionLabel, breakdown })}
            </p>
          )}
          {closed ? (
            <p className="dirty-wt-note dirty-wt-closed-note">{t("dirty.closedNote")}</p>
          ) : (
            <p className="dirty-wt-warning">{t("dirty.warning")}</p>
          )}
          {agentWorking && !closed && (
            <p className="dirty-wt-note dirty-wt-agent-note">{t("dirty.agentWorking")}</p>
          )}
          {moved && (
            <p className="dirty-wt-note dirty-wt-switched-note">
              {t("dirty.switchedNote", { recorded: moved.switchedFrom, actual: moved.branch })}
            </p>
          )}
          {mode === "changes" && (
            <p className="dirty-wt-stash-hint">{committing ? t("dirty.commitHint") : t("dirty.stashHint")}</p>
          )}

          {changes.map((change) => (
            <div key={change.projectId} className="dirty-wt-project" data-project-id={change.projectId}>
              <div className="dirty-wt-project-header">
                <span className="dirty-wt-project-name">{change.projectName}</span>
                {(change.actualBranch ?? change.branchName) && (
                  <span className="dirty-wt-branch-name">{change.actualBranch ?? change.branchName}</span>
                )}
                {change.files.length > 0 && (
                  <span className="dirty-wt-file-breakdown">
                    {formatFileBreakdown(change.files, t)}
                  </span>
                )}
              </div>
              {change.checkError && (
                <div className="dirty-wt-row dirty-wt-row--check-failed">
                  {t("dirty.checkFailed", { project: change.projectName, reason: change.checkError })}
                </div>
              )}
              {(change.lostCommits ?? 0) > 0 && (
                <div className="dirty-wt-row dirty-wt-row--detached">
                  {t((change.lostCommits ?? 0) === 1 ? "dirty.lostOne" : "dirty.lostMany", { count: change.lostCommits ?? 0 })}
                </div>
              )}
              {change.operation && (
                <div className="dirty-wt-row dirty-wt-row--operation">
                  {t("dirty.operation", { operation: t(`dirty.op.${change.operation}`) })}
                </div>
              )}
              {(change.dirtySubmodules ?? []).map((path) => (
                <div key={path} className="dirty-wt-row dirty-wt-row--submodule">
                  {t("dirty.submodule", { path })}
                </div>
              ))}
              {closed && keptPaths?.[change.projectId] && (
                <div className="dirty-wt-row dirty-wt-row--kept">
                  {t("dirty.keptAt", { path: keptPaths[change.projectId] })}
                </div>
              )}
              {change.files.length > 0 && (
                <ul className="dirty-wt-file-list">
                  {change.files.map((file) => (
                    <li key={file.path} className="dirty-wt-file-item">
                      <span className={`dirty-wt-file-status ${statusClass(file.status)}`}>
                        {statusLabel(file.status)}
                      </span>
                      <span className="dirty-wt-file-path">{file.path}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>

        {hookRefusal && (
          <div className="dirty-wt-errors dirty-wt-hook-refused" role="alert">
            <div className="dirty-wt-error-item">
              <span className="dirty-wt-error-label">{hookRefusal.projectName}:</span>{" "}
              <span className="dirty-wt-error-message">
                {t("dirty.hookRefused", { hook: hookRefusal.hook, output: hookRefusal.output })}
              </span>
            </div>
          </div>
        )}

        {/* Errors */}
        {stashErrors && stashErrors.length > 0 && (
          <div className="dirty-wt-errors" role="alert">
            {stashErrors.map((err, i) => (
              <div key={i} className="dirty-wt-error-item">
                <span className="dirty-wt-error-label">
                  {t("dirty.failedFor", { project: err.projectName })}
                </span>{" "}
                <span className="dirty-wt-error-message">{err.error}</span>
                <p className="dirty-wt-error-hint">{t("dirty.stillThere")}</p>
              </div>
            ))}
          </div>
        )}

        {/* Stashing indicator */}
        {stashing && (
          <div className="dirty-wt-stashing" role="status">
            {busyLabel}
          </div>
        )}

        {/* Actions */}
        {mode === "hook-refused" ? (
          <div className="dirty-wt-actions">
            {cancel}
            <Button variant="primary" className="dirty-wt-btn--archive-instead" onClick={() => runBusy(onArchiveAndClose)} disabled={stashing}>
              {t("dirty.archiveInstead")}
            </Button>
          </div>
        ) : mode === "check-failed" ? (
          <div className="dirty-wt-actions">
            <Button variant="danger" className="dirty-wt-btn--close-anyway" onClick={onCloseAnyway} disabled={stashing}>
              {t("dirty.deleteAnyway")}
            </Button>
            {cancel}
            <Button variant="primary" className="dirty-wt-btn--keep" onClick={() => runBusy(onKeepAndClose)} disabled={stashing}>
              {t("dirty.keepAndClose")}
            </Button>
          </div>
        ) : mode === "detached" ? (
          <div className="dirty-wt-actions">
            <Button variant="danger" className="dirty-wt-btn--close-anyway" onClick={onCloseAnyway} disabled={stashing}>
              {t("dirty.discardClose")}
            </Button>
            {cancel}
            <Button variant="primary" className="dirty-wt-btn--save-detached" onClick={() => runBusy(onSaveDetachedAndClose)} disabled={stashing}>
              {stashing ? busyLabel : t("dirty.saveDetached", { branch: detachedArchiveBranch(detachedTarget?.branchName ?? null) })}
            </Button>
          </div>
        ) : mode === "keep-only" ? (
          <div className="dirty-wt-actions">
            <Button variant="danger" className="dirty-wt-btn--close-anyway" onClick={onCloseAnyway} disabled={stashing}>
              {t("dirty.discardClose")}
            </Button>
            {cancel}
            <Button variant="primary" className="dirty-wt-btn--keep" onClick={() => runBusy(onKeepAndClose)} disabled={stashing}>
              {t("dirty.keepAndClose")}
            </Button>
          </div>
        ) : committing ? (
          // Four long choices do not fit one row: the two other ways out sit
          // on a row of their own, above Cancel and the one primary.
          <div className="dirty-wt-actions dirty-wt-actions--rows">
            <div className="dirty-wt-actions-row">
              <Button variant="danger" className="dirty-wt-btn--close-anyway" onClick={onCloseAnyway} disabled={stashing}>
                {t("dirty.discardAndClose")}
              </Button>
              <Button className="dirty-wt-btn--archive" onClick={() => runBusy(onArchiveAndClose)} disabled={stashing}>
                {t("dirty.archiveKeep")}
              </Button>
              {anySubmodule && (
                <Button className="dirty-wt-btn--keep" onClick={() => runBusy(onKeepAndClose)} disabled={stashing}>
                  {t("dirty.keepWorktree")}
                </Button>
              )}
            </div>
            <div className="dirty-wt-actions-row">
              {cancel}
              <Button variant="primary" className="dirty-wt-btn--stash" onClick={() => runBusy(onCommitAndClose)} disabled={stashing}>
                {stashing
                  ? busyLabel
                  : moved
                    ? t("dirty.commitTo", { branch: moved.branch })
                    : t("dirty.commitToSession")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="dirty-wt-actions">
            {cancel}
            <Button variant="danger" className="dirty-wt-btn--close-anyway" onClick={onCloseAnyway} disabled={stashing}>
              {t("dirty.discardAndClose")}
            </Button>
            {anySubmodule && (
              <Button className="dirty-wt-btn--keep" onClick={() => runBusy(onKeepAndClose)} disabled={stashing}>
                {t("dirty.keepWorktree")}
              </Button>
            )}
            <Button variant="primary" className="dirty-wt-btn--stash" onClick={() => runBusy(onStashAndClose)} disabled={stashing}>
              {stashing ? busyLabel : stashErrors && stashErrors.length > 0 ? t("dirty.tryAgain") : t("dirty.stashAndClose")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
