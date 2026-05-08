import "../styles/components/SessionBranchSelector.css";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { gitListBranchesForProject, listWorktrees, checkBranchAvailable, fetchRemoteBranches } from "../api/git";
import { validateBranchName } from "./GitBranchSelector";
import type { GitBranch, WorktreeInfo } from "../types/git";

interface SessionBranchSelectorProps {
  projectId: string;
  onBranchSelected: (branchName: string, createNew: boolean, fromRemote?: string) => void;
  onSkip: () => void;
}

type Tab = "existing" | "new";

interface BranchWithAvailability extends GitBranch {
  taken: boolean;
  takenBySession: string | null;
}

// ─── Pure helpers (exported for testing) ──────────────────────────────

/** Strip remote prefix (e.g. "origin/feature" -> "feature") */
export function stripRemotePrefix(name: string): string {
  const slashIndex = name.indexOf("/");
  return slashIndex >= 0 ? name.slice(slashIndex + 1) : name;
}

/** Extract remote prefix (e.g. "origin/feature" -> "origin/") */
export function getRemotePrefix(name: string): string {
  const slashIndex = name.indexOf("/");
  return slashIndex >= 0 ? name.slice(0, slashIndex + 1) : "";
}

/** Group augmented branches into local and remote sections */
export function groupAugmentedBranches(
  branches: BranchWithAvailability[],
): { local: BranchWithAvailability[]; remote: BranchWithAvailability[] } {
  const local: BranchWithAvailability[] = [];
  const remote: BranchWithAvailability[] = [];
  for (const b of branches) {
    if (b.is_remote) {
      remote.push(b);
    } else {
      local.push(b);
    }
  }
  return { local, remote };
}

/** Display priority for the unified branch list:
 *    0 — `main`         (always at the top when it exists)
 *    1 — `master`       (next priority for legacy repos)
 *    2 — current branch (when it isn't main/master)
 *    3 — everything else, alphabetical
 *
 *  This is a *display* priority — the input list is unchanged.  Pulling
 *  main/master to the top is the single most common destination from
 *  any feature branch; surfacing them by default cuts the time-to-pick
 *  on every session create. */
export function branchDisplayPriority(args: {
  displayName: string;
  isCurrent: boolean;
}): number {
  if (args.displayName === "main") return 0;
  if (args.displayName === "master") return 1;
  if (args.isCurrent) return 2;
  return 3;
}

/** Pure sort that surfaces main/master/current at the top of a unified
 *  branch list, with the rest alphabetical by display name.  Returns a
 *  new array; does not mutate the input.  Exported for unit tests. */
export function sortBranchesMainFirst<T extends { name: string; is_remote: boolean; is_current: boolean }>(
  list: T[],
): T[] {
  return [...list].sort((a, b) => {
    const aName = a.is_remote ? stripRemotePrefix(a.name) : a.name;
    const bName = b.is_remote ? stripRemotePrefix(b.name) : b.name;
    const aPrio = branchDisplayPriority({ displayName: aName, isCurrent: a.is_current });
    const bPrio = branchDisplayPriority({ displayName: bName, isCurrent: b.is_current });
    if (aPrio !== bPrio) return aPrio - bPrio;
    return aName.localeCompare(bName);
  });
}

export function SessionBranchSelector({ projectId, onBranchSelected, onSkip }: SessionBranchSelectorProps) {
  const [tab, setTab] = useState<Tab>("existing");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [fetchingRemotes, setFetchingRemotes] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  // New branch form
  const [newBranchName, setNewBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [checkingAvailability, setCheckingAvailability] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const newBranchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load branches and worktrees on mount
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [branchList, worktreeList] = await Promise.all([
        gitListBranchesForProject(projectId),
        listWorktrees(projectId),
      ]);
      setBranches(branchList);
      setWorktrees(worktreeList);

      // Default base branch to the current branch or first local branch
      const current = branchList.find((b) => b.is_current && !b.is_remote);
      const firstLocal = branchList.find((b) => !b.is_remote);
      setBaseBranch(current?.name || firstLocal?.name || "");

      // Remote branches from the initial list come from cached git refs (no network).
      // Do NOT auto-fetch from network — it blocks Tauri command threads and freezes
      // the UI, especially with multiple projects. The user can manually refresh
      // via the refresh button next to "REMOTE BRANCHES".
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const handleRefreshRemotes = useCallback(() => {
    setFetchingRemotes(true);
    setRemoteError(null);
    const start = Date.now();
    const minDisplayMs = 800;
    fetchRemoteBranches(projectId)
      .then((remoteBranches) => {
        setBranches((prev) => {
          const locals = prev.filter((b) => !b.is_remote);
          return [...locals, ...remoteBranches];
        });
        setRemoteError(null);
      })
      .catch((err) => {
        const msg = String(err);
        if (msg.includes("timed out") || msg.includes("killed")) {
          setRemoteError("Fetch timed out — showing cached branches");
        } else if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) {
          setRemoteError("Authentication required");
        } else {
          setRemoteError("Could not refresh remote branches");
        }
      })
      .finally(() => {
        const elapsed = Date.now() - start;
        const delay = Math.max(0, minDisplayMs - elapsed);
        setTimeout(() => setFetchingRemotes(false), delay);
      });
  }, [projectId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Focus search input when tab changes
  useEffect(() => {
    if (tab === "existing") {
      searchRef.current?.focus();
    } else {
      newBranchRef.current?.focus();
    }
  }, [tab]);

  // Build augmented branch list with availability info
  const takenBranches = useMemo(() => {
    const takenMap = new Map<string, string>();
    for (const wt of worktrees) {
      if (wt.branchName) {
        takenMap.set(wt.branchName, wt.sessionId);
      }
    }
    return takenMap;
  }, [worktrees]);

  const augmentedBranches: BranchWithAvailability[] = useMemo(() => {
    return branches
      .map((b) => ({
        ...b,
        taken: takenBranches.has(b.name),
        takenBySession: takenBranches.get(b.name) || null,
      }));
  }, [branches, takenBranches]);

  // Only local branches for the "New Branch" base selector
  const localAugmentedBranches = useMemo(
    () => augmentedBranches.filter((b) => !b.is_remote),
    [augmentedBranches],
  );

  const localBranchNames = useMemo(
    () => new Set(branches.filter((b) => !b.is_remote).map((b) => b.name)),
    [branches],
  );

  // Build a unified deduplicated branch list: if a branch exists both locally
  // and on a remote, show it once (local version takes priority). Remote-only
  // branches are shown with the remote prefix stripped.
  const unifiedBranches = useMemo(() => {
    const localByName = new Map<string, BranchWithAvailability>();
    const remoteByLocalName = new Map<string, BranchWithAvailability>();

    for (const b of augmentedBranches) {
      if (!b.is_remote) {
        localByName.set(b.name, b);
      } else {
        const localName = stripRemotePrefix(b.name);
        // Only keep first remote per local name (e.g., origin/ takes priority over upstream/)
        if (!remoteByLocalName.has(localName)) {
          remoteByLocalName.set(localName, b);
        }
      }
    }

    const result: (BranchWithAvailability & { remoteOnly?: boolean; localOnly?: boolean })[] = [];

    // Add all local branches, marking those without a remote counterpart
    for (const [name, branch] of localByName) {
      result.push({ ...branch, localOnly: !remoteByLocalName.has(name) });
    }

    // Add remote-only branches (no local counterpart)
    for (const [localName, branch] of remoteByLocalName) {
      if (!localByName.has(localName)) {
        result.push({ ...branch, remoteOnly: true });
      }
    }

    // Surface main → master → current → alphabetical.  Pure sort lives
    // alongside the helpers above so the ordering is unit-tested without
    // having to render the picker.
    return sortBranchesMainFirst(result);
  }, [augmentedBranches]);

  // Filter by search
  const flatFiltered = useMemo(() => {
    if (!search.trim()) return unifiedBranches;
    const q = search.toLowerCase();
    return unifiedBranches.filter((b) => {
      const displayName = b.is_remote ? stripRemotePrefix(b.name) : b.name;
      return displayName.toLowerCase().includes(q) || b.name.toLowerCase().includes(q);
    });
  }, [unifiedBranches, search]);

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightedIndex(-1);
  }, [search]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const items = listRef.current.querySelectorAll(".branch-selector-item");
      items[highlightedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  // Validate new branch name
  useEffect(() => {
    if (!newBranchName.trim()) {
      setValidationError(null);
      return;
    }
    const nameError = validateBranchName(newBranchName);
    if (nameError) {
      setValidationError(nameError);
      return;
    }
    if (localBranchNames.has(newBranchName)) {
      setValidationError("A branch with this name already exists");
      return;
    }
    // Check availability via backend
    setCheckingAvailability(true);
    const timer = setTimeout(() => {
      checkBranchAvailable(projectId, newBranchName)
        .then((result) => {
          if (!result.available) {
            setValidationError(
              result.usedBySession
                ? `Branch is in use by another session`
                : "Branch is not available",
            );
          } else {
            setValidationError(null);
          }
        })
        .catch(() => {
          // Non-blocking — allow creation attempt
          setValidationError(null);
        })
        .finally(() => setCheckingAvailability(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [newBranchName, projectId, localBranchNames]);

  const handleSelectBranch = useCallback(
    (branchName: string) => {
      setSelectedBranch((prev) => (prev === branchName ? null : branchName));
    },
    [],
  );

  const handleConfirmExisting = useCallback(() => {
    if (!selectedBranch) return;
    const branch = augmentedBranches.find((b) => b.name === selectedBranch);
    if (branch?.is_remote) {
      // For remote branches: pass the local name (stripped prefix) and the full remote ref
      const localName = stripRemotePrefix(branch.name);
      onBranchSelected(localName, false, branch.name);
    } else {
      onBranchSelected(selectedBranch, false);
    }
  }, [selectedBranch, augmentedBranches, onBranchSelected]);

  const handleConfirmNew = useCallback(() => {
    if (!newBranchName.trim() || validationError || checkingAvailability) return;
    onBranchSelected(newBranchName.trim(), true);
  }, [newBranchName, validationError, checkingAvailability, onBranchSelected]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (tab === "existing") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, flatFiltered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, -1));
      } else if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        const branch = flatFiltered[highlightedIndex];
        if (branch && !branch.taken) {
          if (selectedBranch === branch.name) {
            handleConfirmExisting();
          } else {
            handleSelectBranch(branch.name);
          }
        }
      }
    } else if (tab === "new") {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirmNew();
      }
    }
  };


  // Loading state
  if (loading) {
    return (
      <div className="branch-selector-body">
        <div className="session-creator-section-title">Select Branch</div>
        <div className="branch-selector-loading">Loading branches...</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="branch-selector-body">
        <div className="session-creator-section-title">Select Branch</div>
        <div className="branch-selector-error">
          <span>Failed to load branches: {error}</span>
          <button className="branch-selector-error-retry" onClick={loadData} title="Retry loading branches">
            Retry
          </button>
        </div>
        <div className="session-creator-actions">
          <button className="session-creator-btn-secondary" onClick={onSkip}>
            Use current branch
          </button>
        </div>
      </div>
    );
  }

  // No branches (not a git repo or empty repo)
  if (unifiedBranches.length === 0) {
    return (
      <div className="branch-selector-body">
        <div className="session-creator-section-title">Select Branch</div>
        <div className="branch-selector-empty">
          No local branches found. This project may not be a git repository,
          or the repository has no commits yet.
        </div>
        <div className="session-creator-actions">
          <button className="session-creator-btn-secondary" onClick={onSkip}>
            Use current branch
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="branch-selector-body" onKeyDown={handleKeyDown}>
      <div className="session-creator-section-title">Select Branch</div>

      {/* Tab switcher */}
      <div className="branch-selector-tabs">
        <button
          className={`branch-selector-tab ${tab === "existing" ? "active" : ""}`}
          onClick={() => setTab("existing")}
        >
          Existing Branch
        </button>
        <button
          className={`branch-selector-tab ${tab === "new" ? "active" : ""}`}
          onClick={() => setTab("new")}
        >
          New Branch
        </button>
        {tab === "existing" && (
          <button
            className="branch-selector-fetch-link"
            onClick={handleRefreshRemotes}
            disabled={fetchingRemotes}
            title="Fetch latest branches from remote"
          >
            {fetchingRemotes ? (
              <><span className="branch-selector-fetch-spinner" /> Fetching...</>
            ) : (
              "↻ Fetch"
            )}
          </button>
        )}
      </div>

      {/* Existing branch tab */}
      {tab === "existing" && (
        <>
          <input
            ref={searchRef}
            className="command-palette-input"
            placeholder="Filter branches..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <div className="branch-selector-list" ref={listRef}>
            {flatFiltered.length === 0 && (
              <div className="branch-selector-empty">
                No branches matching &ldquo;{search}&rdquo;
              </div>
            )}

            {flatFiltered.map((branch, idx) => {
              const displayName = branch.is_remote ? stripRemotePrefix(branch.name) : branch.name;
              return (
                <div
                  key={branch.name}
                  className={[
                    "branch-selector-item",
                    branch.taken ? "branch-selector-item-taken" : "",
                    selectedBranch === branch.name ? "branch-selector-item-selected" : "",
                    highlightedIndex === idx ? "branch-selector-item-highlighted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => !branch.taken && handleSelectBranch(branch.name)}
                  title={branch.last_commit_summary || undefined}
                >
                  <span className="branch-selector-item-name">{displayName}</span>
                  {branch.is_current && (
                    <span className="branch-selector-item-current">current</span>
                  )}
                  {branch.taken && (
                    <span className="branch-selector-item-taken-label">in use</span>
                  )}
                </div>
              );
            })}
          </div>
          {remoteError && (
            <span className="branch-selector-remote-error">{remoteError}</span>
          )}
        </>
      )}

      {/* New branch tab */}
      {tab === "new" && (
        <div className="branch-selector-new-form">
          <div className="branch-selector-field">
            <label className="branch-selector-field-label">Branch Name</label>
            <input
              ref={newBranchRef}
              className={`branch-selector-field-input ${validationError ? "invalid" : ""}`}
              placeholder="feature/my-branch"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {validationError && (
              <span className="branch-selector-validation-error">{validationError}</span>
            )}
          </div>
          <div className="branch-selector-field">
            <label className="branch-selector-field-label">Based On</label>
            <select
              className="branch-selector-field-select"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
            >
              {localAugmentedBranches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}{b.is_current ? " (current)" : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="session-creator-actions">
        <button
          className="session-creator-btn-secondary"
          onClick={onSkip}
          title="Uses the same branch as other sessions — changes will be shared"
        >
          Use current branch
        </button>
        {tab === "existing" ? (
          <button
            className="session-creator-btn-primary"
            onClick={handleConfirmExisting}
            disabled={!selectedBranch}
          >
            Use Branch
          </button>
        ) : (
          <button
            className="session-creator-btn-primary"
            onClick={handleConfirmNew}
            disabled={!newBranchName.trim() || !!validationError || checkingAvailability}
          >
            {checkingAvailability ? "Checking..." : "Create & Use Branch"}
          </button>
        )}
      </div>
    </div>
  );
}
