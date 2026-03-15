import { useEffect, useCallback, useRef } from "react";
import "../styles/components/DirtyWorktreeDialog.css";

export interface DirtyWorktreeChange {
  realmId: string;
  realmName: string;
  branchName: string | null;
  files: Array<{ path: string; status: string }>;
}

export interface StashError {
  realmName: string;
  error: string;
}

interface DirtyWorktreeDialogProps {
  sessionId: string;
  sessionLabel: string;
  changes: DirtyWorktreeChange[];
  stashErrors?: StashError[];
  onStashAndClose: () => void;
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

export function DirtyWorktreeDialog({
  sessionLabel,
  changes,
  stashErrors,
  onStashAndClose,
  onCloseAnyway,
  onCancel,
}: DirtyWorktreeDialogProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }

    // Focus trapping within the dialog
    if (e.key === "Tab" && modalRef.current) {
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
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
  }, [onCancel]);

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

  const totalFiles = changes.reduce((sum, c) => sum + c.files.length, 0);

  return (
    <div className="dirty-wt-overlay" onClick={onCancel}>
      <div
        className="dirty-wt-modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dirty-wt-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="dirty-wt-header">
          <span className="dirty-wt-icon">&#9888;</span>
          <span className="dirty-wt-title" id="dirty-wt-dialog-title">Uncommitted Changes</span>
          <button className="dirty-wt-close" onClick={onCancel} aria-label="Close">&times;</button>
        </div>

        {/* Body */}
        <div className="dirty-wt-body">
          <p className="dirty-wt-message">
            Session <span className="dirty-wt-session-name">{sessionLabel}</span> has{" "}
            {totalFiles} uncommitted {totalFiles === 1 ? "change" : "changes"} across{" "}
            {changes.length} {changes.length === 1 ? "project" : "projects"}.
          </p>

          {changes.map((change) => (
            <div key={change.realmId} className="dirty-wt-project">
              <div className="dirty-wt-project-header">
                <span className="dirty-wt-project-name">{change.realmName}</span>
                {change.branchName && (
                  <span className="dirty-wt-branch-name">{change.branchName}</span>
                )}
              </div>
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
            </div>
          ))}
        </div>

        {/* Stash Errors */}
        {stashErrors && stashErrors.length > 0 && (
          <div className="dirty-wt-errors">
            {stashErrors.map((err, i) => (
              <div key={i} className="dirty-wt-error-item">
                <span className="dirty-wt-error-label">Stash failed for {err.realmName}:</span>{" "}
                <span className="dirty-wt-error-message">{err.error}</span>
                <p className="dirty-wt-error-hint">Your changes are still in the working directory.</p>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="dirty-wt-actions">
          <button className="dirty-wt-btn" onClick={onCancel}>
            Cancel
          </button>
          {stashErrors && stashErrors.length > 0 ? (
            <>
              <button className="dirty-wt-btn dirty-wt-btn--close-anyway" onClick={onCloseAnyway}>
                Close Anyway (changes will be lost)
              </button>
              <button className="dirty-wt-btn dirty-wt-btn--stash" onClick={onStashAndClose}>
                Try Again
              </button>
            </>
          ) : (
            <>
              <button className="dirty-wt-btn dirty-wt-btn--close-anyway" onClick={onCloseAnyway}>
                Close Anyway
              </button>
              <button className="dirty-wt-btn dirty-wt-btn--stash" onClick={onStashAndClose}>
                Stash &amp; Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
