import { memo } from "react";
import type { GitFile } from "../types/git";

interface GitFileRowProps {
  file: GitFile;
  onStage?: (path: string) => void;
  onUnstage?: (path: string) => void;
  onOpen?: (path: string) => void;
  onClick?: (file: GitFile) => void;
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
  onOpen,
  onClick,
}: GitFileRowProps) {
  const info = STATUS_LABELS[file.status] || { letter: "?", className: "git-status-untracked" };

  return (
    <div className="git-file-row" onClick={() => onClick?.(file)}>
      <span className={`git-file-status ${info.className}`}>{info.letter}</span>
      <span className="git-file-path" title={file.path}>
        {file.path}
      </span>
      <div className="git-file-actions">
        {onOpen && (
          <button
            className="git-file-btn git-file-btn-open"
            title="Open file in default editor"
            onClick={(e) => { e.stopPropagation(); onOpen(file.path); }}
          >
            Open
          </button>
        )}
        {file.area === "staged" && onUnstage && (
          <button
            className="git-file-btn git-file-btn-unstage"
            title="Unstage this file"
            onClick={(e) => { e.stopPropagation(); onUnstage(file.path); }}
          >
            Unstage
          </button>
        )}
        {(file.area === "unstaged" || file.area === "untracked") && onStage && (
          <button
            className="git-file-btn git-file-btn-stage"
            title="Stage this file"
            onClick={(e) => { e.stopPropagation(); onStage(file.path); }}
          >
            Stage
          </button>
        )}
      </div>
    </div>
  );
}, (prev, next) =>
  prev.file.path === next.file.path &&
  prev.file.status === next.file.status &&
  prev.file.area === next.file.area
);
