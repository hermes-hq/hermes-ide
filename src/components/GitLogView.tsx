import { useState, useEffect, useRef, useCallback } from "react";
import { gitLog } from "../api/git";
import type { GitLogEntry, GitLogResult } from "../types/git";
import { GitCommitDetailView } from "./GitCommitDetailView";
import { useContextMenu, buildCommitMenuItems } from "../hooks/useContextMenu";
import "../styles/components/GitPanel.css";

// ─── Props ───────────────────────────────────────────────────────────

interface GitLogViewProps {
  sessionId: string;
  realmId: string;
}

// ─── Pure helpers (exported for testing) ─────────────────────────────

export function formatCommitAge(
  timestampSeconds: number,
  nowSeconds?: number,
): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const diff = now - timestampSeconds;

  if (diff < 60) return "just now";

  const minutes = Math.floor(diff / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(diff / 3600);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(diff / 86400);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(diff / 604800);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(diff / 2592000);
  if (months < 12) return `${months}mo ago`;

  const years = Math.floor(diff / 31536000);
  return `${years}y ago`;
}

export function truncateSummary(summary: string, maxLength = 60): string {
  if (summary.length <= maxLength) return summary;

  const truncated = summary.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  if (lastSpace > 0) {
    return truncated.slice(0, lastSpace) + "...";
  }
  // No spaces found – hard truncate
  return truncated + "...";
}

export function isMergeCommit(entry: { parent_count: number }): boolean {
  return entry.parent_count > 1;
}

export function authorColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 60%, 70%)`;
}

export function commitStatsSummary(detail: {
  total_additions: number;
  total_deletions: number;
  files: unknown[];
}): string {
  return `+${detail.total_additions} -${detail.total_deletions} (${detail.files.length} file${detail.files.length === 1 ? "" : "s"})`;
}

// ─── Constants ───────────────────────────────────────────────────────

const PAGE_SIZE = 50;

// ─── Component ───────────────────────────────────────────────────────

export function GitLogView({ sessionId, realmId }: GitLogViewProps) {
  const [entries, setEntries] = useState<GitLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  const offsetRef = useRef(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const fetchingRef = useRef(false);
  // Track the current realmId so stale fetches from a previous realm are discarded
  const realmIdRef = useRef(realmId);

  const contextCommitRef = useRef<GitLogEntry | null>(null);

  const handleCommitAction = useCallback((actionId: string) => {
    const commit = contextCommitRef.current;
    if (!commit) return;
    switch (actionId) {
      case "commit.copy-sha":
        navigator.clipboard.writeText(commit.hash).catch(console.error);
        break;
      case "commit.copy-message":
        navigator.clipboard.writeText(commit.summary).catch(console.error);
        break;
      case "commit.view-details":
        setSelectedHash(commit.hash === selectedHash ? null : commit.hash);
        break;
    }
  }, [selectedHash]);

  const { showMenu: showCommitMenu } = useContextMenu(handleCommitAction);

  // Reset when sessionId or realmId changes
  useEffect(() => {
    realmIdRef.current = realmId;
    setEntries([]);
    setHasMore(true);
    setLoading(false);
    setInitialLoading(true);
    setError(null);
    setSelectedHash(null);
    offsetRef.current = 0;
    fetchingRef.current = false;
  }, [sessionId, realmId]);

  const fetchPage = useCallback(() => {
    if (fetchingRef.current || !hasMore) return;
    fetchingRef.current = true;
    setLoading(true);
    setError(null);

    const fetchRealm = realmId;
    gitLog(sessionId, realmId, PAGE_SIZE, offsetRef.current)
      .then((result: GitLogResult) => {
        // Discard result if realmId changed while fetching
        if (realmIdRef.current !== fetchRealm) {
          fetchingRef.current = false;
          return;
        }
        setEntries((prev) => [...prev, ...result.entries]);
        setHasMore(result.has_more);
        offsetRef.current += result.entries.length;
        setInitialLoading(false);
        setLoading(false);
        fetchingRef.current = false;
      })
      .catch((e) => {
        if (realmIdRef.current !== fetchRealm) {
          fetchingRef.current = false;
          return;
        }
        setError(String(e));
        setInitialLoading(false);
        setLoading(false);
        fetchingRef.current = false;
      });
  }, [sessionId, realmId, hasMore]);

  // Fetch initial page
  useEffect(() => {
    fetchPage();
  }, [sessionId, realmId]); // eslint-disable-line react-hooks/exhaustive-deps

  // IntersectionObserver for lazy loading
  useEffect(() => {
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new IntersectionObserver(
      (observerEntries) => {
        if (observerEntries[0]?.isIntersecting) {
          fetchPage();
        }
      },
      { threshold: 0.1 },
    );

    if (sentinelRef.current) {
      observerRef.current.observe(sentinelRef.current);
    }

    return () => {
      observerRef.current?.disconnect();
    };
  }, [fetchPage]);

  // Attach observer when sentinel ref changes
  const sentinelCallback = useCallback(
    (node: HTMLDivElement | null) => {
      sentinelRef.current = node;
      if (observerRef.current) {
        observerRef.current.disconnect();
        if (node) {
          observerRef.current.observe(node);
        }
      }
    },
    [],
  );

  // ─── Render ──────────────────────────────────────────────────────

  if (initialLoading) {
    return (
      <div className="git-log-view">
        <div className="git-log-loading">Loading history...</div>
      </div>
    );
  }

  if (error && entries.length === 0) {
    return (
      <div className="git-log-view">
        <div className="git-error">{error}</div>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="git-log-view">
        <div className="git-log-empty">No commit history</div>
      </div>
    );
  }

  return (
    <div className="git-log-view">
      <div className="git-log-list">
        {entries.map((entry) => (
          <div
            key={entry.hash}
            className={`git-log-entry${selectedHash === entry.hash ? " git-log-entry-selected" : ""}`}
            onClick={() => setSelectedHash(entry.hash)}
            onContextMenu={(e) => { contextCommitRef.current = entry; showCommitMenu(e, buildCommitMenuItems({ sha: entry.hash, message: entry.summary })); }}
          >
            <div className="git-log-row-top">
              <span className="git-log-hash">{entry.short_hash}</span>
              {isMergeCommit(entry) && (
                <span className="git-log-merge-badge">(merge)</span>
              )}
              <span className="git-log-summary" title={entry.summary}>
                {truncateSummary(entry.summary)}
              </span>
              <span className="git-log-time">
                {formatCommitAge(entry.timestamp)}
              </span>
            </div>
            <div className="git-log-row-bottom">
              <span
                className="git-log-author"
                style={{ color: authorColor(entry.author_email) }}
              >
                {entry.author_name}
              </span>
            </div>
          </div>
        ))}

        {/* Sentinel for IntersectionObserver */}
        {hasMore && (
          <div ref={sentinelCallback} style={{ height: 1 }} />
        )}

        {loading && (
          <div className="git-log-loading">Loading more...</div>
        )}

        {!hasMore && entries.length > 0 && (
          <div className="git-log-end">End of history</div>
        )}

        {error && entries.length > 0 && (
          <div className="git-error">{error}</div>
        )}
      </div>

      {selectedHash && (
        <GitCommitDetailView
          sessionId={sessionId}
          realmId={realmId}
          commitHash={selectedHash}
          onClose={() => setSelectedHash(null)}
        />
      )}
    </div>
  );
}
