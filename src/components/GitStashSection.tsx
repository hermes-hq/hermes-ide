import { useState, useCallback, useEffect, useRef } from "react";
import type { GitStashEntry } from "../types/git";
import {
  gitStashList,
  gitStashSave,
  gitStashApply,
  gitStashPop,
  gitStashDrop,
  gitStashClear,
} from "../api/git";
import { useContextMenu, buildStashMenuItems } from "../hooks/useContextMenu";

// ─── Pure helpers (exported for testing) ──────────────────────────────

export function formatStashAge(timestampSeconds: number, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const diff = now - timestampSeconds;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  const weeks = Math.floor(diff / 604800);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(diff / 2592000);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(diff / 31536000)}y ago`;
}

export function parseStashLabel(message: string): string {
  // "WIP on main: abc1234 Fix bug" -> "Fix bug"
  // "On main: abc1234 Fix bug" -> "Fix bug"
  const wipMatch = message.match(/^(?:WIP )?[Oo]n\s+[^:]+:\s+[a-f0-9]+\s+(.+)$/);
  if (wipMatch) return wipMatch[1];
  // Custom stash messages: "On main: my custom message" (no commit hash)
  const customMatch = message.match(/^(?:WIP )?[Oo]n\s+[^:]+:\s+(.+)$/);
  if (customMatch) return customMatch[1];
  return message;
}

export function parseStashBranch(message: string): string {
  // "WIP on main: ..." -> "main"
  // "On feature/x: ..." -> "feature/x"
  const branchMatch = message.match(/^(?:WIP )?[Oo]n\s+([^:]+):/);
  if (branchMatch) return branchMatch[1];
  return "unknown";
}

// ─── Component ────────────────────────────────────────────────────────

interface GitStashSectionProps {
  sessionId: string;
  realmId: string;
  stashCount: number;
  hasChanges: boolean;
  onRefresh: () => void;
  onToast: (message: string, type?: "success" | "info" | "error") => void;
}

export function GitStashSection({
  sessionId,
  realmId,
  stashCount,
  hasChanges,
  onRefresh,
  onToast,
}: GitStashSectionProps) {
  const [expanded, setExpanded] = useState(stashCount > 0);
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [prevStashCount, setPrevStashCount] = useState(stashCount);

  const contextStashRef = useRef<GitStashEntry | null>(null);

  const handleStashAction = useCallback((actionId: string) => {
    const stash = contextStashRef.current;
    if (!stash) return;
    switch (actionId) {
      case "stash.apply":
        gitStashApply(sessionId, realmId, stash.index)
          .then(() => { onRefresh(); onToast("Stash applied", "success"); })
          .catch((e) => onToast(String(e), "error"));
        break;
      case "stash.pop":
        gitStashPop(sessionId, realmId, stash.index)
          .then(() => { onRefresh(); onToast("Stash popped", "success"); })
          .catch((e) => onToast(String(e), "error"));
        break;
      case "stash.drop":
        gitStashDrop(sessionId, realmId, stash.index)
          .then(() => { onRefresh(); onToast("Stash dropped", "success"); })
          .catch((e) => onToast(String(e), "error"));
        break;
    }
  }, [sessionId, realmId, onRefresh, onToast]);

  const { showMenu: showStashMenu } = useContextMenu(handleStashAction);

  // Auto-dismiss errors after 8 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  // Auto-expand only when stashes appear from zero (not on every count change)
  useEffect(() => {
    if (stashCount !== prevStashCount) {
      if (prevStashCount === 0 && stashCount > 0) {
        setExpanded(true);
      }
      setPrevStashCount(stashCount);
    }
  }, [stashCount, prevStashCount]);

  const loadStashes = useCallback(async () => {
    try {
      setLoading(true);
      const result = await gitStashList(sessionId, realmId);
      setStashes(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, realmId]);

  // Fetch stash list on mount
  useEffect(() => {
    loadStashes();
  }, [loadStashes]);

  // Re-fetch when section expands
  const handleToggle = useCallback(() => {
    setExpanded((v) => {
      const next = !v;
      if (next) loadStashes();
      return next;
    });
  }, [loadStashes]);

  const handleSave = useCallback(async () => {
    try {
      setError(null);
      const result = await gitStashSave(sessionId, realmId, undefined, true);
      onToast(result.message || "Stash saved");
      await loadStashes();
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, realmId, loadStashes, onRefresh, onToast]);

  const handleApply = useCallback(async (index: number) => {
    try {
      setError(null);
      const result = await gitStashApply(sessionId, realmId, index);
      onToast(result.message || `Applied stash@{${index}}`, "info");
      await loadStashes();
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, realmId, loadStashes, onRefresh, onToast]);

  const handlePop = useCallback(async (index: number) => {
    try {
      setError(null);
      const result = await gitStashPop(sessionId, realmId, index);
      onToast(result.message || `Popped stash@{${index}}`, "info");
      await loadStashes();
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, realmId, loadStashes, onRefresh, onToast]);

  const handleDrop = useCallback(async (index: number) => {
    try {
      setError(null);
      setConfirmDrop(null);
      const result = await gitStashDrop(sessionId, realmId, index);
      onToast(result.message || `Dropped stash@{${index}}`);
      await loadStashes();
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, realmId, loadStashes, onRefresh, onToast]);

  const handleClear = useCallback(async () => {
    try {
      setError(null);
      setConfirmClear(false);
      const result = await gitStashClear(sessionId, realmId);
      onToast(result.message || "All stashes cleared");
      await loadStashes();
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, realmId, loadStashes, onRefresh, onToast]);

  const nowSeconds = Math.floor(Date.now() / 1000);

  return (
    <div className="git-stash-section">
      <div className="git-stash-header" onClick={handleToggle}>
        <span className={`git-project-chevron ${expanded ? "git-project-chevron-open" : ""}`}>&#9656;</span>
        <span className="git-stash-label">STASHES ({stashCount})</span>
        <span className="git-stash-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="git-group-btn git-stash-btn-save"
            disabled={!hasChanges}
            onClick={handleSave}
            title="Stash changes (include untracked)"
          >
            Stash
          </button>
          {stashCount > 0 && (
            confirmClear ? (
              <span className="git-stash-confirm">
                <button
                  className="git-branch-delete-yes"
                  onClick={() => handleClear()}
                  title="Confirm clear all stashes"
                >
                  Yes
                </button>
                <button
                  className="git-branch-delete-no"
                  onClick={() => setConfirmClear(false)}
                  title="Cancel"
                >
                  No
                </button>
              </span>
            ) : (
              <button
                className="git-group-btn git-stash-btn-clear"
                onClick={() => setConfirmClear(true)}
                title="Clear all stashes"
              >
                Clear
              </button>
            )
          )}
        </span>
      </div>

      {expanded && (
        <div className="git-stash-list">
          {loading && stashes.length === 0 && (
            <div className="git-stash-empty">Loading stashes...</div>
          )}

          {!loading && stashes.length === 0 && (
            <div className="git-stash-empty">No stashes</div>
          )}

          {stashes.map((entry) => (
            <div className="git-stash-entry" key={entry.index} onContextMenu={(e) => { contextStashRef.current = entry; showStashMenu(e, buildStashMenuItems({ index: entry.index })); }}>
              <span className="git-stash-index">stash@{"{" + entry.index + "}"}</span>
              <span className="git-stash-message" title={entry.message}>
                {parseStashLabel(entry.message)}
              </span>
              <span className="git-stash-time">{formatStashAge(entry.timestamp, nowSeconds)}</span>
              <span className="git-stash-entry-actions">
                {confirmDrop === entry.index ? (
                  <span className="git-stash-confirm">
                    <button
                      className="git-branch-delete-yes"
                      onClick={() => handleDrop(entry.index)}
                      title="Confirm drop"
                    >
                      Yes
                    </button>
                    <button
                      className="git-branch-delete-no"
                      onClick={() => setConfirmDrop(null)}
                      title="Cancel"
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <>
                    <button
                      className="git-group-btn git-stash-btn-apply"
                      onClick={() => handleApply(entry.index)}
                      title="Apply (keep stash)"
                    >
                      Apply
                    </button>
                    <button
                      className="git-group-btn git-stash-btn-pop"
                      onClick={() => handlePop(entry.index)}
                      title="Pop (apply & drop)"
                    >
                      Pop
                    </button>
                    <button
                      className="git-group-btn git-stash-btn-drop"
                      onClick={() => setConfirmDrop(entry.index)}
                      title="Drop this stash"
                    >
                      Drop
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}

          {error && <div className="git-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
