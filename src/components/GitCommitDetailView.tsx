import { useState, useEffect } from "react";
import { gitCommitDetail } from "../api/git";
import type { GitCommitDetail, GitCommitFile } from "../types/git";
import { commitStatsSummary, formatCommitAge } from "./GitLogView";
import "../styles/components/GitPanel.css";

// ─── Props ───────────────────────────────────────────────────────────

interface GitCommitDetailViewProps {
  sessionId: string;
  realmId: string;
  commitHash: string;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function statusLabel(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return status.charAt(0).toUpperCase();
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "added":
      return "git-status-added";
    case "modified":
      return "git-status-modified";
    case "deleted":
      return "git-status-deleted";
    case "renamed":
      return "git-status-renamed";
    default:
      return "";
  }
}

// ─── Component ───────────────────────────────────────────────────────

export function GitCommitDetailView({
  sessionId,
  realmId,
  commitHash,
  onClose,
}: GitCommitDetailViewProps) {
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoading(true);
    setError(null);

    gitCommitDetail(sessionId, realmId, commitHash)
      .then((d) => {
        if (!cancelled) { setDetail(d); setLoading(false); }
      })
      .catch((e) => {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, [sessionId, realmId, commitHash]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const messageParts = detail?.message.split("\n") ?? [];
  const firstLine = messageParts[0] ?? "";

  return (
    <div className="git-commit-detail-overlay" onClick={onClose}>
      <div
        className="git-commit-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="git-commit-detail-header">
          {detail && (
            <span className="git-commit-detail-hash">
              {detail.short_hash}
            </span>
          )}
          {detail && (
            <span className="git-commit-detail-summary">{firstLine}</span>
          )}
          <button className="git-commit-detail-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="git-diff-content">
          {loading && (
            <div className="git-diff-loading">Loading commit details...</div>
          )}

          {error && <div className="git-diff-error">{error}</div>}

          {detail && (
            <>
              {/* Meta row */}
              <div className="git-commit-detail-author">
                {detail.author_name} &lt;{detail.author_email}&gt;
              </div>
              <div className="git-commit-detail-time">
                {formatCommitAge(detail.timestamp)}
              </div>

              {/* Stats summary */}
              <div className="git-commit-detail-stats">
                {commitStatsSummary(detail)}
              </div>

              {/* File list */}
              <div className="git-commit-detail-files">
                {detail.files.map((file: GitCommitFile) => (
                  <div
                    key={file.path + file.status}
                    className="git-commit-detail-file"
                  >
                    <span
                      className={`git-commit-detail-file-status ${statusClass(file.status)}`}
                    >
                      {statusLabel(file.status)}
                    </span>
                    <span className="git-commit-detail-file-path">
                      {file.old_path && file.status === "renamed"
                        ? `${file.old_path} \u2192 ${file.path}`
                        : file.path}
                    </span>
                    <span className="git-commit-detail-file-stats">
                      <span className="git-diff-additions">
                        +{file.additions}
                      </span>{" "}
                      <span className="git-diff-deletions">
                        -{file.deletions}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
