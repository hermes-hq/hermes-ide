import { memo, useState } from "react";
import type { GitFile } from "../types/git";
import { GitActionButton } from "./GitActionButton";

interface GitFileRowProps {
  file: GitFile;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onDiscard?: (path: string) => void;
  onOpen?: (path: string) => void;
  onClick?: (file: GitFile) => void;
  onContextMenu?: (e: React.MouseEvent, file: GitFile) => void;
  /** The Review Desk's Changes section: the row's actions are the control set's buttons. */
  kit?: boolean;
}

const STATUS_LABELS: Record<string, { letter: string; className: string }> = {
  modified: { letter: "M", className: "git-status-modified" },
  added: { letter: "A", className: "git-status-added" },
  deleted: { letter: "D", className: "git-status-deleted" },
  renamed: { letter: "R", className: "git-status-renamed" },
  copied: { letter: "C", className: "git-status-copied" },
  untracked: { letter: "?", className: "git-status-untracked" },
  conflicted: { letter: "!", className: "git-status-conflicted" },
};

export const GitFileRow = memo(function GitFileRow({
  file,
  onStage,
  onUnstage,
  onDiscard,
  onOpen,
  onClick,
  onContextMenu,
  kit = false,
}: GitFileRowProps) {
  const info = STATUS_LABELS[file.status] || { letter: "?", className: "git-status-untracked" };
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  return (
    <div className="git-file-row" data-path={file.path} data-area={file.area} onClick={() => onClick?.(file)} onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); e.stopPropagation(); onContextMenu(e, file); } }}>
      <span className={`git-file-status ${info.className}`}>{info.letter}</span>
      {/* The folder gives way first, so the file name stays readable. */}
      <span className="git-file-path" title={file.path}>
        {file.path.includes("/") && <span className="git-file-dir">{file.path.slice(0, file.path.lastIndexOf("/") + 1)}</span>}
        <span className="git-file-base">{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
      </span>
      <div className="git-file-actions">
        {onOpen && (
          <GitActionButton
            kit={kit}
            variant="quiet"
            kitClass="git-file-action git-file-action-open"
            legacyClass="git-file-btn git-file-btn-open"
            title="Open file in default editor"
            onClick={(e) => { e.stopPropagation(); onOpen(file.path); }}
          >
            Open
          </GitActionButton>
        )}
        {file.area === "staged" && onUnstage && (
          <GitActionButton
            kit={kit}
            variant="quiet"
            kitClass="git-file-action git-file-action-unstage"
            legacyClass="git-file-btn git-file-btn-unstage"
            title="Unstage this file"
            onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }}
          >
            Unstage
          </GitActionButton>
        )}
        {file.area === "unstaged" && file.status !== "untracked" && onDiscard && (
          confirmDiscard ? (
            <>
              <GitActionButton
                kit={kit}
                variant="danger"
                kitClass="git-file-action git-file-action-discard-confirm"
                legacyClass="git-file-btn git-file-btn-discard-confirm"
                title="Confirm discard"
                onClick={(e) => { e.stopPropagation(); onDiscard(file.path); setConfirmDiscard(false); }}
              >
                Confirm
              </GitActionButton>
              <GitActionButton
                kit={kit}
                variant="quiet"
                kitClass="git-file-action git-file-action-cancel"
                legacyClass="git-file-btn git-file-btn-open"
                title="Cancel"
                onClick={(e) => { e.stopPropagation(); setConfirmDiscard(false); }}
              >
                Cancel
              </GitActionButton>
            </>
          ) : (
            <GitActionButton
              kit={kit}
              variant="quiet"
              kitClass="git-file-action git-file-action-discard"
              legacyClass="git-file-btn git-file-btn-discard"
              title="Discard changes (restore to last commit)"
              onClick={(e) => { e.stopPropagation(); setConfirmDiscard(true); }}
            >
              Discard
            </GitActionButton>
          )
        )}
        {(file.area === "unstaged" || file.area === "untracked") && onStage && (
          <GitActionButton
            kit={kit}
            variant="quiet"
            kitClass="git-file-action git-file-action-stage"
            legacyClass="git-file-btn git-file-btn-stage"
            title="Stage this file"
            onClick={(e) => { e.stopPropagation(); onStage(file.path); }}
          >
            Stage
          </GitActionButton>
        )}
      </div>
    </div>
  );
}, (prev, next) =>
  prev.file.path === next.file.path &&
  prev.file.status === next.file.status &&
  prev.file.area === next.file.area &&
  prev.kit === next.kit
);
