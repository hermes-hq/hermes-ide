import { useState, useEffect } from "react";
import { gitDiff } from "../api/git";
import type { GitFile, GitDiff } from "../types/git";
import "../styles/components/GitPanel.css";

interface GitDiffViewProps {
  projectPath: string;
  file: GitFile;
  onClose: () => void;
}

export function GitDiffView({ projectPath, file, onClose }: GitDiffViewProps) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // 2F: Clear old diff immediately before fetching new one
    setDiff(null);
    setLoading(true);
    setError(null);
    const staged = file.area === "staged";
    gitDiff(projectPath, file.path, staged)
      .then((d) => { if (!cancelled) { setDiff(d); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [projectPath, file.path, file.area]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="git-diff-overlay" onClick={onClose}>
      <div className="git-diff-modal" onClick={(e) => e.stopPropagation()}>
        <div className="git-diff-header">
          <span className="git-diff-path">{file.path}</span>
          {diff && !diff.is_binary && (
            <span className="git-diff-stats">
              <span className="git-diff-additions">+{diff.additions}</span>
              <span className="git-diff-deletions">-{diff.deletions}</span>
            </span>
          )}
          <button className="git-diff-close" onClick={onClose}>&times;</button>
        </div>
        <div className="git-diff-content">
          {loading && <div className="git-diff-loading">Loading diff...</div>}
          {error && <div className="git-diff-error">{error}</div>}
          {diff && diff.is_binary && (
            <div className="git-diff-binary">Binary file</div>
          )}
          {diff && !diff.is_binary && (
            <pre className="git-diff-text">
              {diff.diff_text.split("\n").map((line, i) => {
                let className = "git-diff-line";
                if (line.startsWith("@@")) className += " git-diff-line-hunk";
                else if (line.startsWith("+++") || line.startsWith("---")) className += " git-diff-line-header";
                else if (line.startsWith("+")) className += " git-diff-line-add";
                else if (line.startsWith("-")) className += " git-diff-line-del";
                return (
                  <div key={i} className={className}>
                    {line}
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
