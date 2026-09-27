import { useState, useEffect, useCallback, useMemo } from "react";
import {
  listAllWorktrees,
  detectOrphanWorktrees,
  worktreeDiskUsage,
  cleanupOrphanWorktrees,
  getDiskStatus,
  getWorktreeUsage,
  reclaimBuildOutput,
  listOrphanFolders,
  sweepOrphanFolders,
} from "../api/git";
import type {
  WorktreeOverviewEntry, OrphanWorktree, CleanupResult, DiskStatus, WorktreeUsage, OrphanFolder, SweepResult,
} from "../types/git";
import { isFeatureFlagEnabled } from "../featureFlags";
import "../styles/components/WorktreeOverviewPanel.css";

// ─── Helpers ──────────────────────────────────────────────────────────

/** Decimal units ("4.2 GB"), as the OS shows disk space; matches the 10 GB guard. */
export function formatDiskBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** An orphaned folder from the disk-guard scan, in the shape the list renders. */
export function orphanFolderToEntry(folder: OrphanFolder): OrphanWorktree {
  return {
    worktree_path: folder.worktree_path,
    branch_name: folder.branch_hint,
    kind: "directory_only",
    root_path: folder.repo_path,
    session_id: null,
  };
}

/**
 * The flag-on orphan list: every orphaned folder from the disk-guard scan,
 * plus records whose folder is already gone (only the old detection finds
 * those; its folder entries are left out, the scan covers them).
 */
export function mergeOrphanLists(folders: OrphanFolder[], detected: OrphanWorktree[]): OrphanWorktree[] {
  return [...folders.map(orphanFolderToEntry), ...detected.filter((o) => o.kind === "record_only")];
}

/** Sweep results in the shape the results strip renders. */
export function sweepToCleanupResults(results: SweepResult[]): CleanupResult[] {
  return results.map((r) => ({ path: r.path, success: r.removed, error: r.error }));
}

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
  // Replace home directory with ~ (cross-platform)
  const home = fullPath
    .replace(/^\/Users\/[^/]+/, "~")       // macOS
    .replace(/^\/home\/[^/]+/, "~")         // Linux
    .replace(/^[A-Z]:\\Users\\[^\\]+/i, "~"); // Windows
  if (home.length <= maxLen) return home;
  const parts = home.split(/[/\\]/);
  if (parts.length > 4) {
    return parts[0] + "/\u2026/" + parts.slice(-2).join("/");
  }
  return "\u2026" + home.slice(home.length - maxLen);
}

function formatWorktreeError(raw: string): string {
  if (raw.includes("Permission denied")) return "Permission denied \u2014 check file permissions.";
  if (raw.includes("index.lock")) return "Git is busy \u2014 another operation is in progress. Try again.";
  if (raw.includes("No such file")) return "Directory not found \u2014 it may have been already removed.";
  return `Unexpected error: ${raw}`;
}

/**
 * Extract a short, user-friendly label from a worktree path for use in tooltips.
 * Full paths like `/Users/.../hermes-worktrees/hash/session_branch` become
 * just the branch + session info.
 */
export function friendlyWorktreeTooltip(
  worktreePath: string,
  branchName?: string | null,
  sessionLabel?: string,
): string {
  const parts: string[] = [];
  if (branchName) parts.push(branchName);
  if (sessionLabel) parts.push(sessionLabel);
  if (parts.length > 0) return parts.join(" — ");
  // Fallback: use last segment of path
  return worktreePath.split("/").pop() || worktreePath;
}

// ─── Types ────────────────────────────────────────────────────────────

interface ProjectGroup {
  projectId: string;
  projectName: string;
  rootPath: string;
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
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  // Disk guard (feature flag): free space, per-worktree usage, build output.
  const diskGuard = isFeatureFlagEnabled("diskGuard");
  const [diskStatus, setDiskStatus] = useState<DiskStatus | null>(null);
  const [usage, setUsage] = useState<Record<string, WorktreeUsage>>({});
  const [reclaiming, setReclaiming] = useState<Set<string>>(new Set());
  const [reclaimNote, setReclaimNote] = useState<string | null>(null);
  const [sweepNote, setSweepNote] = useState<{ folders: number; bytes: number; records: number } | null>(null);

  // Load data on mount
  useEffect(() => {
    loadData();
  }, []);

  // Auto-dismiss cleanup results (longer timeout if any failures)
  useEffect(() => {
    if (!cleanupResults) return;
    const hasFailures = cleanupResults.some((r) => !r.success);
    const dismissTime = hasFailures ? 10000 : 6000;
    const timer = setTimeout(() => setCleanupResults(null), dismissTime);
    return () => clearTimeout(timer);
  }, [cleanupResults]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wts, orps] = await Promise.all([
        listAllWorktrees(),
        diskGuard
          ? Promise.all([listOrphanFolders(), detectOrphanWorktrees().catch(() => [])]).then(([f, d]) =>
            mergeOrphanLists(f, d),
          )
          : detectOrphanWorktrees(),
      ]);
      setWorktrees(wts);
      setOrphans(orps);
      if (diskGuard) {
        setUsage({});
        setDiskUsage({});
        getDiskStatus().then(setDiskStatus).catch(() => setDiskStatus(null));
      }
      // Auto-expand all projects on first load
      const projectIds = new Set(wts.map((w) => w.project_id));
      // Disk guard: orphans of repos with no live worktree are shown open too.
      if (diskGuard) for (const o of orps) projectIds.add(o.root_path || o.worktree_path);
      setExpandedProjects(projectIds);
    } catch (e) {
      console.error("Failed to load worktree overview:", e);
      setError(formatWorktreeError(String(e)));
    } finally {
      setLoading(false);
    }
  }, [diskGuard]);

  // Disk guard: measure every linked worktree and orphan, one at a time (a
  // walk over node_modules is heavy), so each row shows the disk it uses.
  useEffect(() => {
    if (!diskGuard) return;
    let cancelled = false;
    const paths = [
      ...worktrees.filter((w) => !w.is_main_worktree).map((w) => w.worktree_path),
      ...orphans.filter((o) => o.kind === "directory_only").map((o) => o.worktree_path),
    ];
    (async () => {
      for (const path of paths) {
        if (cancelled) return;
        try {
          const u = await getWorktreeUsage(path);
          if (cancelled) return;
          setUsage((prev) => ({ ...prev, [path]: u }));
          setDiskUsage((prev) => ({ ...prev, [path]: u.total_bytes }));
        } catch {
          // Folder vanished or is not a worktree folder: no size to show.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [diskGuard, worktrees, orphans]);

  // Group worktrees by project
  const projectGroups = useMemo((): ProjectGroup[] => {
    const groupMap = new Map<string, ProjectGroup>();

    for (const wt of worktrees) {
      let group = groupMap.get(wt.project_id);
      if (!group) {
        group = {
          projectId: wt.project_id,
          projectName: wt.project_name,
          rootPath: wt.root_path,
          worktrees: [],
          orphans: [],
        };
        groupMap.set(wt.project_id, group);
      }
      group.worktrees.push(wt);
    }

    // Attach orphans to matching project groups by root_path, or create standalone groups
    for (const orphan of orphans) {
      let placed = false;
      if (orphan.root_path) {
        for (const group of groupMap.values()) {
          if (group.rootPath === orphan.root_path) {
            group.orphans.push(orphan);
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        // Create a standalone group for orphans without a matching project
        const key = orphan.root_path || orphan.worktree_path;
        let group = groupMap.get(key);
        if (!group) {
          group = {
            projectId: key,
            projectName: orphan.root_path ? orphan.root_path.split("/").pop() || "Unknown" : "Orphaned",
            rootPath: orphan.root_path || "",
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
  const filteredGroups = useMemo((): ProjectGroup[] => {
    if (!search.trim()) return projectGroups;
    const q = search.toLowerCase();
    return projectGroups
      .map((group) => ({
        ...group,
        worktrees: group.worktrees.filter(
          (wt) =>
            (wt.branch_name && wt.branch_name.toLowerCase().includes(q)) ||
            wt.session_label.toLowerCase().includes(q) ||
            wt.project_name.toLowerCase().includes(q),
        ),
        orphans: group.orphans.filter(
          (o) =>
            (o.branch_name && o.branch_name.toLowerCase().includes(q)) ||
            o.worktree_path.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.worktrees.length > 0 || g.orphans.length > 0);
  }, [projectGroups, search]);

  // Total stats
  const totalWorktrees = worktrees.length + orphans.length;
  const totalDiskUsage = Object.values(diskUsage).reduce((sum, v) => sum + v, 0);
  const orphanBytes = orphans.reduce((sum, o) => sum + (usage[o.worktree_path]?.total_bytes ?? 0), 0);
  const selectedOrphanBytes = Array.from(selectedOrphans).reduce(
    (sum, path) => sum + (usage[path]?.total_bytes ?? 0),
    0,
  );

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

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
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
      let results: CleanupResult[];
      if (diskGuard) {
        // Folders go through the sweep; records whose folder is gone only
        // need their row removed, which the old cleanup does.
        const recordOnly = new Set(orphans.filter((o) => o.kind === "record_only").map((o) => o.worktree_path));
        const selected = Array.from(selectedOrphans);
        const folderPaths = selected.filter((p) => !recordOnly.has(p));
        const recordPaths = selected.filter((p) => recordOnly.has(p));
        const swept = folderPaths.length > 0 ? await sweepOrphanFolders(folderPaths) : [];
        const cleared = recordPaths.length > 0 ? await cleanupOrphanWorktrees(recordPaths) : [];
        results = [...sweepToCleanupResults(swept), ...cleared];
        setSweepNote({
          folders: swept.filter((r) => r.removed).length,
          bytes: swept.reduce((sum, r) => sum + r.freed_bytes, 0),
          records: cleared.filter((r) => r.success).length,
        });
      } else {
        results = await cleanupOrphanWorktrees(Array.from(selectedOrphans));
      }
      setCleanupResults(results);
      const failed = results.filter((r) => !r.success);
      if (failed.length > 0) {
        console.warn("Some cleanups failed:", failed);
      }
      // Refresh data
      await loadData();
      setSelectedOrphans(new Set());
    } catch (e) {
      setError(formatWorktreeError(String(e)));
    } finally {
      setCleaning(false);
    }
  }, [selectedOrphans, loadData, diskGuard, orphans]);

  /** Disk guard: one action for every orphan — select them all and ask once. */
  const requestRemoveAllOrphans = useCallback(() => {
    setSelectedOrphans(new Set(orphans.map((o) => o.worktree_path)));
    setConfirmCleanup(true);
  }, [orphans]);

  const handleReclaim = useCallback(async (path: string, label: string) => {
    setReclaiming((prev) => new Set(prev).add(path));
    try {
      const result = await reclaimBuildOutput(path);
      const removed = result.removed.length;
      setReclaimNote(
        removed === 0
          ? `No build output to remove in ${label}.`
          : `Removed ${result.removed.join(", ")} from ${label}: freed ${formatDiskBytes(result.freed_bytes)}.` +
            (result.failed.length > 0 ? ` Could not remove: ${result.failed.join("; ")}` : ""),
      );
      const u = await getWorktreeUsage(path);
      setUsage((prev) => ({ ...prev, [path]: u }));
      setDiskUsage((prev) => ({ ...prev, [path]: u.total_bytes }));
      getDiskStatus().then(setDiskStatus).catch(() => {});
    } catch (e) {
      setError(formatWorktreeError(String(e)));
    } finally {
      setReclaiming((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const handleCopyPath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch(() => {});
  }, []);

  // ─── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="worktree-overview">
        <div className="worktree-overview-loading">Loading working copies...</div>
      </div>
    );
  }

  return (
    <div className="worktree-overview">
      {/* Search + Refresh */}
      <div className="worktree-overview-search">
        <input
          className="worktree-overview-search-input"
          placeholder="Search working copies..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search working copies"
        />
        <button
          className="worktree-overview-refresh"
          onClick={loadData}
          title="Refresh"
          aria-label="Refresh working copies"
        >
          &#8635;
        </button>
      </div>

      {diskGuard && diskStatus && (
        <div
          className={`worktree-disk-status ${diskStatus.below_threshold ? "worktree-disk-status-low" : ""}`}
          data-free-bytes={diskStatus.free_bytes ?? ""}
        >
          {diskStatus.free_bytes === null
            ? "Free disk space: unknown"
            : `Free disk space: ${formatDiskBytes(diskStatus.free_bytes)}`}
          {diskStatus.below_threshold && (
            <span className="worktree-disk-status-warning">
              {` — under ${formatDiskBytes(diskStatus.required_bytes)}: new worktrees are refused`}
            </span>
          )}
        </div>
      )}

      {diskGuard && reclaimNote && (
        <div className="worktree-reclaim-note" role="status">{reclaimNote}</div>
      )}

      {diskGuard && sweepNote && cleanupResults && (
        <div className="worktree-sweep-note" role="status">
          {(sweepNote.folders > 0 || sweepNote.records === 0
            ? `Removed ${sweepNote.folders} orphaned folder${sweepNote.folders !== 1 ? "s" : ""}: freed ${formatDiskBytes(sweepNote.bytes)}.`
            : "") +
            (sweepNote.records > 0
              ? `${sweepNote.folders > 0 ? " " : ""}Cleared ${sweepNote.records} record${sweepNote.records !== 1 ? "s" : ""} of working copies already deleted.`
              : "")}
        </div>
      )}

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
            {search ? "No working copies match your search." : "No working copies found."}
          </div>
        )}

        {filteredGroups.map((group) => {
          const isExpanded = expandedProjects.has(group.projectId);
          const entryCount = group.worktrees.length + group.orphans.length;

          return (
            <div key={group.projectId} className="worktree-overview-project">
              {/* Project Header */}
              <div
                className="worktree-overview-project-header"
                onClick={() => toggleProject(group.projectId)}
              >
                <span
                  className={`worktree-overview-project-chevron ${isExpanded ? "worktree-overview-project-chevron-open" : ""}`}
                >
                  &#9656;
                </span>
                <span className="worktree-overview-project-name">
                  {group.projectName}
                </span>
                <span className="worktree-overview-project-count">
                  {entryCount}
                </span>
              </div>

              {isExpanded && group.rootPath && (
                <div
                  className="worktree-overview-project-path"
                  title={group.rootPath}
                >
                  <span className="worktree-overview-project-path-text">
                    {truncatePath(group.rootPath)}
                  </span>
                </div>
              )}

              {isExpanded && (
                <div className="worktree-overview-project-body">
                  {/* Active worktrees */}
                  {group.worktrees.map((wt) => (
                    <div key={wt.worktree_path} className="worktree-overview-entry" data-worktree-path={wt.worktree_path}>
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
                              <span className="worktree-overview-stale" title="This working copy is older than 14 days">stale</span>
                            )}
                          </span>
                          {wt.last_activity_at && (
                            <span className="worktree-overview-activity">
                              Active: {timeAgo(wt.last_activity_at)}
                            </span>
                          )}
                          {diskGuard && !wt.is_main_worktree && (
                            <span
                              className="worktree-overview-disk-size"
                              data-total-bytes={usage[wt.worktree_path]?.total_bytes ?? ""}
                              data-build-output-bytes={usage[wt.worktree_path]?.build_output_bytes ?? ""}
                              title="Disk used by this working copy"
                            >
                              {usage[wt.worktree_path]
                                ? formatDiskBytes(usage[wt.worktree_path].total_bytes) +
                                  (usage[wt.worktree_path].build_output_bytes > 0
                                    ? ` (build output ${formatDiskBytes(usage[wt.worktree_path].build_output_bytes)})`
                                    : "")
                                : "measuring\u2026"}
                            </span>
                          )}
                          {!diskGuard && diskUsage[wt.worktree_path] !== undefined && (
                            <span className="worktree-overview-disk-size">
                              {formatBytes(diskUsage[wt.worktree_path])}
                            </span>
                          )}
                          {!diskGuard && diskUsage[wt.worktree_path] === undefined && (
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
                        {diskGuard && !wt.is_main_worktree && (usage[wt.worktree_path]?.build_output_bytes ?? 0) > 0 && (
                          <button
                            className="worktree-overview-action-btn worktree-reclaim-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReclaim(wt.worktree_path, wt.branch_name || wt.session_label);
                            }}
                            disabled={reclaiming.has(wt.worktree_path)}
                            title="Remove node_modules, target and dist folders that git ignores (they can be rebuilt)"
                          >
                            {reclaiming.has(wt.worktree_path) ? "Removing\u2026" : "Remove build output"}
                          </button>
                        )}
                        <button
                          className="worktree-overview-action-btn worktree-overview-action-btn-open"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCopyPath(wt.worktree_path);
                          }}
                          title={`Copy path: ${friendlyWorktreeTooltip(wt.worktree_path, wt.branch_name, wt.session_label)}`}
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
                      data-worktree-path={orphan.worktree_path}
                    >
                      <input
                        type="checkbox"
                        className="worktree-overview-orphan-checkbox"
                        checked={selectedOrphans.has(orphan.worktree_path)}
                        onChange={() => toggleOrphanSelection(orphan.worktree_path)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select orphan ${orphan.worktree_path}`}
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
                            {orphan.kind === "directory_only" ? "Leftover directory" : "Missing directory"}
                          </span>
                          {diskGuard && orphan.kind === "directory_only" && (
                            <span
                              className="worktree-overview-disk-size"
                              data-total-bytes={usage[orphan.worktree_path]?.total_bytes ?? ""}
                            >
                              {usage[orphan.worktree_path]
                                ? formatDiskBytes(usage[orphan.worktree_path].total_bytes)
                                : "measuring…"}
                            </span>
                          )}
                          {!diskGuard && diskUsage[orphan.worktree_path] !== undefined && (
                            <span className="worktree-overview-disk-size">
                              {formatBytes(diskUsage[orphan.worktree_path])}
                            </span>
                          )}
                          {!diskGuard && diskUsage[orphan.worktree_path] === undefined && (
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
                          title={`Copy path: ${friendlyWorktreeTooltip(orphan.worktree_path, orphan.branch_name)}`}
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
            Clean up {selectedOrphans.size} orphan{selectedOrphans.size > 1 ? "s" : ""}
            {diskGuard && selectedOrphanBytes > 0 ? ` (${formatDiskBytes(selectedOrphanBytes)})` : ""}?
            {diskGuard && " Their files are deleted, including uncommitted changes."}
          </span>
          <button
            className="worktree-overview-confirm-yes worktree-overview-confirm-destructive"
            onClick={handleCleanup}
          >
            {`Delete ${selectedOrphans.size} working ${selectedOrphans.size !== 1 ? "copies" : "copy"}`}
          </button>
          <button
            className="worktree-overview-confirm-no"
            onClick={() => setConfirmCleanup(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Footer */}
      <div className="worktree-overview-footer">
        <div className="worktree-overview-footer-stats">
          <span>{totalWorktrees} working {totalWorktrees !== 1 ? "copies" : "copy"}</span>
          {totalDiskUsage > 0 && (
            <span>{diskGuard ? formatDiskBytes(totalDiskUsage) : formatBytes(totalDiskUsage)}</span>
          )}
          {orphans.length > 0 && !diskGuard && (
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
        {diskGuard && orphans.length > 0 && !confirmCleanup && (
          <button
            className="worktree-overview-cleanup-btn worktree-sweep-btn"
            onClick={requestRemoveAllOrphans}
            disabled={cleaning}
            title="Delete every orphaned worktree folder (folders no session owns)"
          >
            {cleaning
              ? "Removing…"
              : `Remove all orphans (${orphans.length}${orphanBytes > 0 ? `, ${formatDiskBytes(orphanBytes)}` : ""})`}
          </button>
        )}
        {selectedOrphans.size > 0 && !confirmCleanup && (
          <button
            className="worktree-overview-cleanup-btn"
            onClick={() => setConfirmCleanup(true)}
            disabled={cleaning}
            aria-label="Clean up selected orphans"
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
