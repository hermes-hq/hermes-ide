import "../styles/components/SessionBranchSelector.css";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { gitListBranchesForProject, listWorktrees, checkBranchAvailable, fetchRemoteBranches } from "../api/git";
import { validateBranchName } from "./GitBranchSelector";
import { defaultTaskBranch } from "../state/isolation";
import { findBranchClash } from "../utils/branchClash";
import type { GitBranch, WorktreeInfo } from "../types/git";
import { useI18n } from "../i18n/I18nProvider";
import { Badge, Button, Input, Segmented, Select } from "./ui";
import { cx } from "./ui/Button";

interface SessionBranchSelectorProps {
  projectId: string;
  /**
   * Branch the parent already has stored for this project (if any).
   *
   * Bug 2 follow-up: the selector auto-propagates the current local
   * branch to the parent on mount so the user doesn't have to click
   * "Use Branch" for the common case.  When the user collapses then
   * re-expands the same project, the selector remounts, runs loadData
   * again, and would re-propagate.  The parent's auto-advance effect
   * watches `branchSelections` and collapses the panel when every
   * project has a selection — so on every re-expand the panel would
   * snap shut, making it impossible to change the branch.
   *
   * When `existingBranchName` is provided we:
   *   1. Skip the auto-propagation (the parent already knows).
   *   2. Pre-select the existing branch in the list so the user sees
   *      what's currently chosen and can change it.
   */
  existingBranchName?: string;
  /**
   * Honest isolation (flag `honestIsolation`): when set, the default is a
   * NEW branch `hermes/<slug>` cut from HEAD (made unique against the
   * repo's branches) instead of the current branch, and the "New branch"
   * tab starts filled in with it so it can be edited.
   */
  defaultTaskSlug?: string;
  onBranchSelected: (branchName: string, createNew: boolean, fromRemote?: string) => void;
  onSkip: () => void;
  /**
   * What the open "New branch" form holds, so the step's own Continue can
   * commit a name the user typed but did not confirm with "Create & use"
   * (it used to go on with the proposed branch instead). `ok` is false while
   * the name is one that cannot be created. null: nothing typed, the other
   * tab, or the picker closed.
   */
  onDraftChange?: (draft: BranchDraft | null) => void;
}

export interface BranchDraft {
  name: string;
  ok: boolean;
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

export function SessionBranchSelector({ projectId, existingBranchName, defaultTaskSlug, onBranchSelected, onSkip, onDraftChange }: SessionBranchSelectorProps) {
  const { t } = useI18n();
  // Keep the latest onBranchSelected behind a ref so loadData can read
  // it without including it in the useCallback dependency array.  The
  // parent re-creates the inline callback on every render; if we put it
  // in the dep array, loadData (and therefore the load effect) would
  // re-fire on every parent render and re-issue the git_list_branches
  // IPC, freezing the UI.
  const onBranchSelectedRef = useRef(onBranchSelected);
  onBranchSelectedRef.current = onBranchSelected;

  // Mirror `existingBranchName` behind a ref for the same reason — the
  // parent passes a fresh value on every render via
  // `branchSelections[projectId]?.branch`, but we only need the value
  // at mount time inside loadData.
  const existingBranchNameRef = useRef(existingBranchName);
  existingBranchNameRef.current = existingBranchName;
  const defaultTaskSlugRef = useRef(defaultTaskSlug);
  defaultTaskSlugRef.current = defaultTaskSlug;

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

      // Bug 2 fix (1.2.x):
      // Auto-propagate the current local branch so the parent's
      // `branchSelections[projectId]` is populated even when the user
      // doesn't click "Use Branch" explicitly.  Before this, clicking
      // SessionCreator's project-list "Continue" submitted with
      // `branchSelections: undefined` and the agent session booted on
      // the current branch with no worktree isolation.
      //
      // Constraints:
      //   - Only propagate when a current LOCAL branch exists
      //     (detached HEAD / remote-only repos must NOT auto-pick).
      //   - Only propagate when no other session's worktree already
      //     claims that branch (avoids the "branch in use" failure
      //     downstream in git_create_worktree).
      //   - Skip propagation when the parent already has a selection
      //     for this project (we're re-mounting because the user
      //     clicked the chevron to change their mind).  Without this
      //     guard the parent's auto-advance effect would re-fire and
      //     instantly collapse the panel, making re-selection
      //     impossible — that was the "expand closes super fast"
      //     follow-up bug observed during manual testing of the
      //     v1.2.x Bug 2 fix.
      //
      // The user can still override by selecting a different branch +
      // "Use Branch", or skip isolation entirely via "Use current
      // branch" (which calls onSkip and clears the selection upstream).
      const priorSelection = existingBranchNameRef.current;
      const taskSlug = defaultTaskSlugRef.current;
      if (taskSlug) {
        // Honest isolation: every task gets its own new branch by default,
        // so two tasks never land in the same checkout. Editable in the
        // "New branch" tab, which starts filled in with it.
        const localNames = branchList.filter((b) => !b.is_remote).map((b) => b.name);
        const proposed = defaultTaskBranch(taskSlug, localNames);
        const shown = priorSelection ?? proposed;
        const priorIsExisting = !!priorSelection && localNames.includes(priorSelection);
        setNewBranchName(priorIsExisting ? proposed : shown);
        setTab(priorIsExisting ? "existing" : "new");
        if (priorSelection) setSelectedBranch(priorSelection);
        else if (localNames.length > 0 || current) onBranchSelectedRef.current(proposed, true);
      } else if (priorSelection) {
        // Pre-highlight the user's existing choice so they can see it
        // and either click another row or click "Use Branch" to keep
        // it.  We deliberately do NOT call onBranchSelected here — the
        // parent already has this selection.
        setSelectedBranch(priorSelection);
      } else if (current) {
        const taken = worktreeList.some((wt) => wt.branchName === current.name);
        if (!taken) {
          // Read through the ref so loadData's deps stay stable.
          onBranchSelectedRef.current(current.name, false);
        }
      }

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

  // A typed name that is an existing branch, also when only the letter case
  // differs (on macOS and Windows `Develop` IS `develop`): never "new".
  const nameClash = useMemo(
    () => (newBranchName.trim() ? findBranchClash(newBranchName.trim(), localBranchNames) : null),
    [newBranchName, localBranchNames],
  );
  const clashedBranch = nameClash && nameClash.kind !== "folder"
    ? augmentedBranches.find((b) => !b.is_remote && b.name === nameClash.existing)
    : undefined;

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
    if (nameClash) {
      setValidationError(
        nameClash.kind === "same"
          ? t("branch.exists", { branch: nameClash.existing })
          : nameClash.kind === "case"
            ? t("branch.caseClash", { branch: nameClash.existing })
            : t("branch.folderClash", { branch: nameClash.existing }),
      );
      return;
    }
    // Check availability via backend. An answer that comes back after the
    // name changed belongs to the old name and must not touch the error.
    let stale = false;
    setCheckingAvailability(true);
    const timer = setTimeout(() => {
      checkBranchAvailable(projectId, newBranchName)
        .then((result) => {
          if (stale) return;
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
          if (!stale) setValidationError(null);
        })
        .finally(() => {
          if (!stale) setCheckingAvailability(false);
        });
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
      setCheckingAvailability(false);
    };
  }, [newBranchName, projectId, nameClash, t]);

  // Tell the parent what the New branch form holds (see onDraftChange). While
  // the availability check runs, the last answer belongs to the previous name.
  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const draftName = tab === "new" ? newBranchName.trim() : "";
  const draftOk =
    !!draftName &&
    !validateBranchName(draftName) &&
    !nameClash &&
    (checkingAvailability || !validationError);
  useEffect(() => {
    onDraftChangeRef.current?.(draftName ? { name: draftName, ok: draftOk } : null);
  }, [draftName, draftOk]);
  useEffect(() => () => onDraftChangeRef.current?.(null), []);

  /**
   * Single-click commits.  Clicking a row on the Existing Branch tab fires
   * `onBranchSelected` immediately — there is no intermediate "highlighted
   * but uncommitted" state any more.
   *
   * Why: in multi-project sessions the old select-then-confirm flow was a
   * silent trap.  Users would click a branch in each expanded picker, never
   * realise they also had to click "Use Branch", and end up with zero
   * isolated branches.  The outer modal's "Continue" / "Continue without
   * isolation" buttons now own the only legitimate confirmation gate.
   *
   * The visual "selected" state (`selectedBranch`) survives only as a brief
   * flash before the parent collapses the picker — see the row className.
   */
  const handleCommitBranch = useCallback(
    (branchName: string) => {
      const branch = augmentedBranches.find((b) => b.name === branchName);
      if (!branch || branch.taken) return;
      setSelectedBranch(branchName); // for the brief visual ack
      if (branch.is_remote) {
        // For remote branches: pass the local name (stripped prefix) and the
        // full remote ref so the worktree backend can fetch it.
        onBranchSelected(stripRemotePrefix(branch.name), false, branch.name);
      } else {
        onBranchSelected(branchName, false);
      }
    },
    [augmentedBranches, onBranchSelected],
  );

  const handleConfirmNew = useCallback(() => {
    if (!newBranchName.trim() || validationError || checkingAvailability) return;
    onBranchSelected(newBranchName.trim(), true);
  }, [newBranchName, validationError, checkingAvailability, onBranchSelected]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // A control that took the key (the tabs' arrows, the base branch list) keeps it.
    if (e.defaultPrevented) return;
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
        // Single Enter commits — matches the mouse single-click contract.
        if (branch && !branch.taken) {
          handleCommitBranch(branch.name);
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
        <div className="session-creator-section-title">{t("branch.selectBranch")}</div>
        <div className="branch-selector-loading">{t("branch.loading")}</div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="branch-selector-body">
        <div className="session-creator-section-title">{t("branch.selectBranch")}</div>
        <div className="branch-selector-error">
          <span>{t("branch.loadFailed", { error })}</span>
          <Button size="sm" className="branch-selector-error-retry" onClick={loadData} title={t("branch.retryLoading")}>
            {t("common.retry")}
          </Button>
        </div>
        <div className="session-creator-actions">
          <Button className="session-creator-btn-secondary" onClick={onSkip}>
            {t("branch.useCurrent")}
          </Button>
        </div>
      </div>
    );
  }

  // No branches (not a git repo or empty repo)
  if (unifiedBranches.length === 0) {
    return (
      <div className="branch-selector-body">
        <div className="session-creator-section-title">{t("branch.selectBranch")}</div>
        <div className="branch-selector-empty">
          {t("branch.noneFound")}
        </div>
        <div className="session-creator-actions">
          <Button className="session-creator-btn-secondary" onClick={onSkip}>
            {t("branch.useCurrent")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="branch-selector-body" onKeyDown={handleKeyDown}>
      <div className="session-creator-section-title">{t("branch.selectBranch")}</div>

      {/* Tab switcher */}
      <div className="branch-selector-bar">
        <Segmented<Tab>
          className="branch-selector-tabs"
          label={t("branch.selectBranch")}
          value={tab}
          onChange={setTab}
          options={[
            { value: "existing", label: t("branch.existingBranch"), attrs: { className: cx("branch-selector-tab", tab === "existing" && "active") } },
            { value: "new", label: t("branch.newBranch"), attrs: { className: cx("branch-selector-tab", tab === "new" && "active") } },
          ]}
        />
        {tab === "existing" && (
          <Button
            variant="quiet"
            size="sm"
            className="branch-selector-fetch-link"
            onClick={handleRefreshRemotes}
            disabled={fetchingRemotes}
            loading={fetchingRemotes}
            title={t("branch.fetchLatest")}
          >
            {fetchingRemotes ? t("branch.fetching") : `↻ ${t("branch.fetch")}`}
          </Button>
        )}
      </div>

      {/* Existing branch tab */}
      {tab === "existing" && (
        <>
          <Input
            ref={searchRef}
            className="branch-selector-filter"
            aria-label={t("branch.filterBranches")}
            placeholder={t("branch.filterBranches")}
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
                {t("branch.noMatches", { query: search })}
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
                    branch.is_remote ? "branch-selector-item-remote" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => handleCommitBranch(branch.name)}
                  title={branch.last_commit_summary || undefined}
                >
                  <span className="branch-selector-item-name">{displayName}</span>
                  {branch.is_current && (
                    <Badge tone="success" className="branch-selector-item-current">{t("branch.current")}</Badge>
                  )}
                  {branch.is_remote && !branch.taken && (
                    <Badge tone="info" className="branch-selector-item-remote-badge">{t("branch.remote")}</Badge>
                  )}
                  {branch.taken && (
                    <Badge className="branch-selector-item-taken-label">{t("branch.inUse")}</Badge>
                  )}
                  {/* Hover-only affordance telegraphing single-click commits.
                      Hidden on .branch-selector-item-taken via CSS. */}
                  {!branch.taken && (
                    <span className="branch-selector-item-commit-hint" aria-hidden="true">→</span>
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
            <label className="branch-selector-field-label" htmlFor={`branch-selector-name-${projectId}`}>{t("branch.branchName")}</label>
            <Input
              id={`branch-selector-name-${projectId}`}
              ref={newBranchRef}
              code
              className="branch-selector-field-input"
              placeholder="feature/my-branch"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              // Not the field's `error`: that draws the input anew when the
              // message comes and goes, and the typing would lose the focus.
              invalid={!!validationError}
              aria-describedby={validationError ? `branch-selector-name-error-${projectId}` : undefined}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {validationError && (
              <span id={`branch-selector-name-error-${projectId}`} className="h-field-error branch-selector-validation-error">
                {validationError}
              </span>
            )}
            {/* The name is an existing branch: use that one on purpose, or type another name. */}
            {clashedBranch && !clashedBranch.taken && (
              <Button
                variant="link"
                size="sm"
                className="branch-selector-use-existing"
                data-branch={clashedBranch.name}
                onClick={() => handleCommitBranch(clashedBranch.name)}
              >
                {t("branch.useExisting", { branch: clashedBranch.name })}
              </Button>
            )}
          </div>
          <div className="branch-selector-field">
            <span className="branch-selector-field-label" id={`branch-selector-base-${projectId}`}>{t("branch.basedOn")}</span>
            <Select
              code
              className="branch-selector-field-select"
              aria-labelledby={`branch-selector-base-${projectId}`}
              value={baseBranch}
              onChange={setBaseBranch}
              options={localAugmentedBranches.map((b) => ({
                value: b.name,
                label: b.name,
                detail: b.is_current ? t("branch.current") : undefined,
              }))}
            />
          </div>
        </div>
      )}

      {/* Actions
       *
       * Existing tab: the redundant "Use Branch" button is gone — single-click
       * on a row commits the selection (the silent multi-project confirmation
       * trap is what we're fixing).  "Use current branch" stays, because it's
       * the only per-project escape from isolation in multi-project sessions;
       * the outer "Continue without isolation" skips ALL projects, which is a
       * different operation.
       *
       * New tab: the submit button stays — the user is typing into a form and
       * there is nothing to single-click on. */}
      <div className="session-creator-actions">
        <Button
          className="session-creator-btn-secondary"
          onClick={onSkip}
          title={t("branch.useCurrentHint")}
        >
          {t("branch.useCurrent")}
        </Button>
        {/* Secondary: the branch step's one primary is its own Continue. */}
        {tab === "new" && (
          <Button
            className="branch-selector-create"
            onClick={handleConfirmNew}
            disabled={!newBranchName.trim() || !!validationError || checkingAvailability}
          >
            {checkingAvailability ? t("common.checking") : t("branch.createAndUse")}
          </Button>
        )}
      </div>
    </div>
  );
}
