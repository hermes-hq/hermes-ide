import { useState, useEffect, useCallback, useMemo } from "react";
import {
  listAllWorktrees,
  detectOrphanWorktrees,
  worktreeDiskUsage,
  cleanupOrphanWorktrees,
} from "../api/git";
import type { WorktreeOverviewEntry, OrphanWorktree, CleanupResult } from "../types/git";
import "../styles/components/WorktreeOverviewPanel.css";

// ─── Helpers ──────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function isStale(createdAt: string, daysThreshold: number = 14): boolean {
  const created = new Date(createdAt);
  const now = new Date();
  const diffDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays > daysThreshold;
}

function truncatePath(fullPath: string, maxLen = 50): string {
  const home = fullPath.replace(/^\/Users\/[^/]+/, "~");
  if (home.length <= maxLen) return home;
  const parts = home.split("/");
  if (parts.length > 4) {
    return parts[0] + "/\u2026/" + parts.slice(-2).join("/");
  }
  return "\u2026" + home.slice(home.length - maxLen);
}

// ─── Types ────────────────────────────────────────────────────────────

interface RealmGroup {
  realmId: string;
  realmName: string;
  realmPath: string;
  worktrees: WorktreeOverviewEntry[];
  orphans: OrphanWorktree[];
}

// ─── Component ────────────────────────────────────────────────────────

export function WorktreeOverviewPanel() {
  const [worktrees, setWorktrees] = useState<WorktreeOverviewEntry[]>([]);
  const [orphans, setOrphans] = useState<OrphanWorktree[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [diskUsage, setDiskUsage] = useState<Record<string, number>>({});
  const [diskLoading, setDiskLoading] = useState<Set<string>>(new Set());
  const [selectedOrphans, setSelectedOrphans] = useState<Set<string>>(new Set());
  const [cleaning, setCleaning] = useState(false);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [cleanupResults, setCleanupResults] = useState<CleanupResult[] | null>(null);
  const [expandedRealms, setExpandedRealms] = useState<Set<string>>(new Set());

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  // Auto-dismiss cleanup results
  useEffect(() => {
    if (!cleanupResults) return;
    const timer = setTimeout(() => setCleanupResults(null), 6000);
    return () => clearTimeout(timer);
  }, [cleanupResults]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wts, orps] = await Promise.all([
        listAllWorktrees(),
        detectOrphanWorktrees(),
      ]);
      setWorktrees(wts);
      setOrphans(orps);
      // Auto-expand all realms on first load
      const realmIds = new Set(wts.map((w) => w.realm_id));
      setExpandedRealms(realmIds);
    } catch (e) {
      console.error("Failed to load worktree overview:", e);
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Group worktrees by realm
  const realmGroups = useMemo((): RealmGroup[] => {
    const groupMap = new Map<string, RealmGroup>();

    for (const wt of worktrees) {
      let group = groupMap.get(wt.realm_id);
      if (!group) {
        group = {
          realmId: wt.realm_id,
          realmName: wt.realm_name,
          realmPath: wt.realm_path,
          worktrees: [],
          orphans: [],
        };
        groupMap.set(wt.realm_id, group);
      }
      group.worktrees.push(wt);
    }

    // Attach orphans to matching realm groups by realm_path, or create standalone groups
    for (const orphan of orphans) {
      let placed = false;
      if (orphan.realm_path) {
        for (const group of groupMap.values()) {
          if (group.realmPath === orphan.realm_path) {
            group.orphans.push(orphan);
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        // Create a standalone group for orphans without a matching realm
        const key = orphan.realm_path || orphan.worktree_path;
        let group = groupMap.get(key);
        if (!group) {
          group = {
            realmId: key,
            realmName: orphan.realm_path ? orphan.realm_path.split("/").pop() || "Unknown" : "Orphaned",
            realmPath: orphan.realm_path || "",
            worktrees: [],
            orphans: [],
          };
          groupMap.set(key, group);
        }
        group.orphans.push(orphan);
      }
    }

    return Array.from(groupMap.values());
  }, [worktrees, orphans]);

  // Apply search filter
  const filteredGroups = useMemo((): RealmGroup[] => {
    if (!search.trim()) return realmGroups;
    const q = search.toLowerCase();
    return realmGroups
      .map((group) => ({
        ...group,
        worktrees: group.worktrees.filter(
          (wt) =>
            (wt.branch_name && wt.branch_name.toLowerCase().includes(q)) ||
            wt.session_label.toLowerCase().includes(q) ||
            wt.realm_name.toLowerCase().includes(q),
        ),
        orphans: group.orphans.filter(
          (o) =>
            (o.branch_name && o.branch_name.toLowerCase().includes(q)) ||
            o.worktree_path.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.worktrees.length > 0 || g.orphans.length > 0);
  }, [realmGroups, search]);

  // Total stats
  const totalWorktrees = worktrees.length + orphans.length;
  const totalDiskUsage = Object.values(diskUsage).reduce((sum, v) => sum + v, 0);

  // ─── Handlers ─────────────────────────────────────────────────────

  const handleLoadDiskUsage = useCallback(async (path: string) => {
    if (diskUsage[path] !== undefined || diskLoading.has(path)) return;
    setDiskLoading((prev) => new Set(prev).add(path));
    try {
      const bytes = await worktreeDiskUsage(path);
      setDiskUsage((prev) => ({ ...prev, [path]: bytes }));
    } catch {
      // Silently ignore disk usage errors
    } finally {
      setDiskLoading((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, [diskUsage, diskLoading]);

  const toggleRealm = useCallback((realmId: string) => {
    setExpandedRealms((prev) => {
      const next = new Set(prev);
      if (next.has(realmId)) next.delete(realmId);
      else next.add(realmId);
      return next;
    });
  }, []);

  const toggleOrphanSelection = useCallback((path: string) => {
    setSelectedOrphans((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAllOrphans = useCallback(() => {
    setSelectedOrphans(new Set(orphans.map((o) => o.worktree_path)));
  }, [orphans]);

  const handleCleanup = useCallback(async () => {
    if (selectedOrphans.size === 0) return;
    setCleaning(true);
    setConfirmCleanup(false);
    try {
      const results = await cleanupOrphanWorktrees(Array.from(selectedOrphans));
      setCleanupResults(results);
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        console.warn("Some cleanups failed:", failed);
      }
      // Refresh data
      await loadData();
      setSelectedOrphans(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setCleaning(false);
    }
  }, [selectedOrphans, loadData]);

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {});
  }, []);

  // ─── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="worktree-overview">
        <div className="worktree-overview-loading">Loading worktrees...</div>
      </div>
    );
  }

  return (
    <div className="worktree-overview">
      {/* Search + Refresh */}
      <div className="worktree-overview-search">
        <input
          className="worktree-overview-search-input"
          placeholder="Search worktrees..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="worktree-overview-refresh"
          onClick={loadData}
          title="Refresh"
        >
          &#8635;
        </button>
      </div>

      {error && (
        <div className="worktree-overview-error">{error}</div>
      )}

      {/* Cleanup results */}
      {cleanupResults && (
        <div className="worktree-overview-results">
          {cleanupResults.map((r) => (
            <div
              key={r.path}
              className={r.success ? "worktree-overview-result-success" : "worktree-overview-result-failure"}
            >
              {r.success ? "\u2713" : "\u2717"} {r.path.split("/").pop()}
              {r.error && ` - ${r.error}`}
            </div>
          ))}
        </div>
      )}

      {/* Main content */}
      <div className="worktree-overview-scroll">
        {filteredGroups.length === 0 && !error && (
          <div className="worktree-overview-empty">
            {search ? "No worktrees match your search." : "No worktrees found."}
          </div>
        )}

        {filteredGroups.map((group) => {
          const isExpanded = expandedRealms.has(group.realmId);
          const entryCount = group.worktrees.length + group.orphans.length;

          return (
            <div key={group.realmId} className="worktree-overview-realm">
              {/* Realm Header */}
              <div
                className="worktree-overview-realm-header"
                onClick={() => toggleRealm(group.realmId)}
              >
                <span
                  className={`worktree-overview-realm-chevron ${isExpanded ? "worktree-overview-realm-chevron-open" : ""}`}
                >
                  &#9656;
                </span>
                <span className="worktree-overview-realm-name">
                  {group.realmName}
                </span>
                <span className="worktree-overview-realm-count">
                  {entryCount}
                </span>
              </div>

              {isExpanded && group.realmPath && (
                <div
                  className="worktree-overview-realm-path"
                  title={group.realmPath}
                >
                  <span className="worktree-overview-realm-path-text">
                    {truncatePath(group.realmPath)}
                  </span>
                </div>
              )}

              {isExpanded && (
                <div className="worktree-overview-realm-body">
                  {/* Active worktrees */}
                  {group.worktrees.map((wt) => (
                    <div key={wt.worktree_path} className="worktree-overview-entry">
                      <span className="worktree-overview-entry-icon">
                        {wt.is_main_worktree ? "\u25CF" : "\u25CB"}
                      </span>
                      <div className="worktree-overview-entry-info">
                        <div className="worktree-overview-entry-branch">
                          {wt.branch_name || "(detached)"}
                          {wt.is_main_worktree && (
                            <span className="worktree-overview-main-badge">main</span>
                          )}
                        </div>
                        <div className="worktree-overview-entry-session">
                          {wt.session_label}
                        </div>
                        <div className="worktree-overview-entry-meta">
                          <span className="worktree-overview-age">
                            {timeAgo(wt.created_at)}
                            {isStale(wt.created_at) && (
                              <span className="worktree-overview-stale" title="This worktree is older than 14 days">stale</span>
                            )}
                          </span>
                          {wt.last_activity_at && (
                            <span className="worktree-overview-activity">
                              Active: {timeAgo(wt.last_activity_at)}
                            </span>
                          )}
                          {diskUsage[wt.worktree_path] !== undefined && (
                            <span className="worktree-overview-disk-size">
                              {formatBytes(diskUsage[wt.worktree_path])}
                            </span>
                          )}
                          {diskUsage[wt.worktree_path] === undefined && (
                            <button
                              className="worktree-overview-disk-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleLoadDiskUsage(wt.worktree_path);
                              }}
                              disabled={diskLoading.has(wt.worktree_path)}
                              title="Show disk usage"
                            >
                              {diskLoading.has(wt.worktree_path) ? "..." : "\u2022 size"}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="worktree-overview-actions">
                        <button
                          className="worktree-overview-action-btn worktree-overview-action-btn-open"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPath(wt.worktree_path);
                          }}
                          title={`Copy path: ${wt.worktree_path}`}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  ))}

                  {/* Orphan worktrees */}
                  {group.orphans.map((orphan) => (
                    <div
                      key={orphan.worktree_path}
                      className="worktree-overview-entry worktree-overview-orphan"
                    >
                      <input
                        type="checkbox"
                        className="worktree-overview-orphan-checkbox"
                        checked={selectedOrphans.has(orphan.worktree_path)}
                        onChange={() => toggleOrphanSelection(orphan.worktree_path)}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <span className="worktree-overview-orphan-icon">
                        &#9888;
                      </span>
                      <div className="worktree-overview-entry-info">
                        <div className="worktree-overview-entry-branch">
                          {orphan.branch_name || "(unknown)"}
                          <span className="worktree-overview-orphan-label">
                            {" "}ORPHANED
                          </span>
                        </div>
                        <div className="worktree-overview-entry-meta">
                          <span className="worktree-overview-orphan-kind">
                            {orphan.kind === "directory_only" ? "dir only" : "record only"}
                          </span>
                          {diskUsage[orphan.worktree_path] !== undefined && (
                            <span className="worktree-overview-disk-size">
                              {formatBytes(diskUsage[orphan.worktree_path])}
                            </span>
                          )}
                          {diskUsage[orphan.worktree_path] === undefined && (
                            <button
                              className="worktree-overview-disk-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleLoadDiskUsage(orphan.worktree_path);
                              }}
                              disabled={diskLoading.has(orphan.worktree_path)}
                              title="Show disk usage"
                            >
                              {diskLoading.has(orphan.worktree_path) ? "..." : "\u2022 size"}
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="worktree-overview-actions">
                        <button
                          className="worktree-overview-action-btn worktree-overview-action-btn-open"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPath(orphan.worktree_path);
                          }}
                          title={`Copy path: ${orphan.worktree_path}`}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Cleanup confirmation */}
      {confirmCleanup && (
        <div className="worktree-overview-confirm">
          <span className="worktree-overview-confirm-text">
            Clean up {selectedOrphans.size} orphan{selectedOrphans.size > 1 ? "s" : ""}?
          </span>
          <button
            className="worktree-overview-confirm-yes"
            onClick={handleCleanup}
          >
            Yes
          </button>
          <button
            className="worktree-overview-confirm-no"
            onClick={() => setConfirmCleanup(false)}
          >
            No
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="worktree-overview-footer">
        <div className="worktree-overview-footer-stats">
          <span>{totalWorktrees} worktree{totalWorktrees !== 1 ? "s" : ""}</span>
          {totalDiskUsage > 0 && (
            <span>{formatBytes(totalDiskUsage)}</span>
          )}
          {orphans.length > 0 && (
            <span>
              {orphans.length} orphan{orphans.length !== 1 ? "s" : ""}
              {selectedOrphans.size < orphans.length && (
                <button
                  className="worktree-overview-disk-btn"
                  onClick={selectAllOrphans}
                  title="Select all orphans"
                  style={{ marginLeft: 4 }}
                >
                  select all
                </button>
              )}
            </span>
          )}
        </div>
        {selectedOrphans.size > 0 && !confirmCleanup && (
          <button
            className="worktree-overview-cleanup-btn"
            onClick={() => setConfirmCleanup(true)}
            disabled={cleaning}
          >
            {cleaning
              ? "Cleaning..."
              : `Clean up (${selectedOrphans.size})`}
          </button>
        )}
      </div>
    </div>
  );
}
