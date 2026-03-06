import { useState, useEffect } from "react";
import { gitGetConflictContent } from "../api/git";
import type { ConflictContent, ConflictStrategy } from "../types/git";

// ─── Props ───────────────────────────────────────────────────────────

interface GitConflictViewerProps {
  sessionId: string;
  realmId: string;
  filePath: string;
  onResolve: (filePath: string, strategy: ConflictStrategy) => void;
  onClose: () => void;
}

// ─── Helpers ─────────────────────────────────────────────────────────

type MarkerType = "boundary-ours" | "ours" | "separator" | "theirs" | "boundary-theirs" | "normal";

function classifyLine(line: string, state: { zone: "normal" | "ours" | "theirs" }): MarkerType {
  if (line.startsWith("<<<<<<< ")) {
    state.zone = "ours";
    return "boundary-ours";
  }
  if (line === "=======" && state.zone === "ours") {
    state.zone = "theirs";
    return "separator";
  }
  if (line.startsWith(">>>>>>> ") && state.zone === "theirs") {
    state.zone = "normal";
    return "boundary-theirs";
  }
  if (state.zone === "ours") return "ours";
  if (state.zone === "theirs") return "theirs";
  return "normal";
}

const MARKER_CLASS_MAP: Record<MarkerType, string> = {
  "boundary-ours": "git-conflict-marker-boundary git-conflict-marker-ours",
  "ours": "git-conflict-marker-ours",
  "separator": "git-conflict-marker-separator",
  "theirs": "git-conflict-marker-theirs",
  "boundary-theirs": "git-conflict-marker-boundary git-conflict-marker-theirs",
  "normal": "",
};

// ─── Component ───────────────────────────────────────────────────────

export function GitConflictViewer({
  sessionId,
  realmId,
  filePath,
  onResolve,
  onClose,
}: GitConflictViewerProps) {
  const [content, setContent] = useState<ConflictContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setLoading(true);
    setError(null);

    gitGetConflictContent(sessionId, realmId, filePath)
      .then((c) => {
        if (!cancelled) { setContent(c); setLoading(false); }
      })
      .catch((e) => {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      });
    return () => { cancelled = true; };
  }, [sessionId, realmId, filePath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="git-conflict-overlay" onClick={onClose}>
      <div className="git-conflict-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="git-conflict-header">
          <span className="git-conflict-header-path">{filePath}</span>
          <button className="git-diff-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Content */}
        <div className="git-conflict-content">
          {loading && (
            <div className="git-diff-loading">Loading conflict content...</div>
          )}
          {error && <div className="git-diff-error">{error}</div>}
          {content && content.is_binary && (
            <div className="git-diff-binary">Binary file &mdash; cannot display conflict markers</div>
          )}
          {content && !content.is_binary && (
            <pre className="git-conflict-text">
              {(() => {
                const lines = content.working_tree.split("\n");
                const state = { zone: "normal" as "normal" | "ours" | "theirs" };
                return lines.map((line, i) => {
                  const markerType = classifyLine(line, state);
                  const cls = MARKER_CLASS_MAP[markerType];
                  return (
                    <div key={i} className={`git-conflict-line${cls ? ` ${cls}` : ""}`}>
                      {line}
                    </div>
                  );
                });
              })()}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="git-conflict-footer">
          <button
            className="git-conflict-btn git-conflict-btn-ours"
            onClick={() => onResolve(filePath, "ours")}
          >
            Accept Ours
          </button>
          <button
            className="git-conflict-btn git-conflict-btn-theirs"
            onClick={() => onResolve(filePath, "theirs")}
          >
            Accept Theirs
          </button>
          <button
            className="git-conflict-btn git-conflict-btn-resolved"
            onClick={() => onResolve(filePath, "manual")}
          >
            Mark Resolved
          </button>
          <button
            className="git-conflict-btn git-conflict-btn-close"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
