import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { GitBranch } from "../types/git";
import { gitListBranches, gitBranchesAheadBehind, gitCreateBranch, gitCheckoutBranch, gitDeleteBranch } from "../api/git";
import type { GitToast } from "./GitPanel";
import { useContextMenu, buildBranchMenuItems } from "../hooks/useContextMenu";
import { branchClashMessage, findBranchClash, gitErrorMessage } from "../utils/branchClash";
import { parseUnmergedBranch, type UnmergedBranch } from "../utils/gitErrors";
import { translate } from "../i18n/registry";
import { Button } from "./ui";

interface GitBranchSelectorProps {
  sessionId: string;
  projectId: string;
  currentBranch: string | null;
  onRefresh: () => void;
  onToast: (message: string, type?: GitToast["type"]) => void;
  onClose: () => void;
  /** Ref to the element that triggered the dropdown, used for fixed positioning */
  triggerRef?: React.RefObject<HTMLElement | null>;
  /**
   * Ask before switching: "task-worktree" (a task's isolated worktree:
   * its agent's next commits and Land follow the branch), "agent-folder"
   * (an agent works in the project folder). Null: switch on one click.
   */
  confirmSwitch?: "task-worktree" | "agent-folder" | null;
  /** The agent's name, for the "agent-folder" question. */
  agentName?: string | null;
}

// ─── Pure helpers (exported for testing) ──────────────────────────────

export function filterBranches(branches: GitBranch[], query: string): GitBranch[] {
  if (!query.trim()) return branches;
  const q = query.toLowerCase();
  return branches.filter((b) => b.name.toLowerCase().includes(q));
}

export function groupBranches(branches: GitBranch[]): { local: GitBranch[]; remote: GitBranch[] } {
  const local: GitBranch[] = [];
  const remote: GitBranch[] = [];
  for (const b of branches) {
    if (b.is_remote) {
      remote.push(b);
    } else {
      local.push(b);
    }
  }
  // Sort current branch first in local group
  local.sort((a, b) => {
    if (a.is_current && !b.is_current) return -1;
    if (!a.is_current && b.is_current) return 1;
    return a.name.localeCompare(b.name);
  });
  remote.sort((a, b) => a.name.localeCompare(b.name));
  return { local, remote };
}

export function validateBranchName(name: string): string | null {
  if (!name.trim()) return "Branch name cannot be empty";
  if (/\s/.test(name)) return "Branch name cannot contain spaces";
  if (name.startsWith("-")) return "Branch name cannot start with '-'";
  if (name.startsWith(".")) return "Branch name cannot start with '.'";
  if (name.includes("..")) return "Branch name cannot contain '..'";
  if (name.includes("//")) return "Branch name cannot contain consecutive slashes";
  if (name.endsWith(".lock")) return "Branch name cannot end with '.lock'";
  if (name.endsWith(".")) return "Branch name cannot end with '.'";
  if (name.endsWith("/")) return "Branch name cannot end with '/'";
  if (name.includes("@{")) return "Branch name cannot contain '@{'";
  if (/[~^:?*\[\]\\]/.test(name)) return "Branch name contains invalid characters";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return "Branch name cannot contain control characters";
  return null;
}

/**
 * Where a position:fixed box's (0, 0) is: the window, or the nearest
 * ancestor that is its containing block (a transform, filter or backdrop
 * filter makes one).
 */
function fixedOrigin(el: HTMLElement): { top: number; left: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const cs = getComputedStyle(p) as CSSStyleDeclaration & { webkitBackdropFilter?: string };
    const makesBlock = [cs.transform, cs.filter, cs.backdropFilter, cs.webkitBackdropFilter, cs.perspective].some((v) => !!v && v !== "none");
    if (makesBlock) {
      const r = p.getBoundingClientRect();
      return { top: r.top, left: r.left };
    }
  }
  return { top: 0, left: 0 };
}

export function GitBranchSelector({ sessionId, projectId, currentBranch, onRefresh, onToast, onClose, triggerRef, confirmSwitch = null, agentName = null }: GitBranchSelectorProps) {
  // translate, not useI18n: also rendered outside the I18n provider (panel tests).
  const t = translate;
  /** A branch about to be checked out, waiting for "Switch". */
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  /** A delete git refused because the branch has commits no other branch has. */
  const [unmerged, setUnmerged] = useState<UnmergedBranch | null>(null);
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [fixedStyle, setFixedStyle] = useState<React.CSSProperties>({});

  // Position the fixed dropdown below the trigger element's parent section
  useLayoutEffect(() => {
    const trigger = triggerRef?.current;
    if (!trigger) return;
    // Use the closest .git-project-section as the anchor for full-width alignment
    const section = trigger.closest(".git-project-section") as HTMLElement | null;
    const anchor = section || trigger;
    const rect = anchor.getBoundingClientRect();
    const maxH = 320;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const top = spaceBelow >= maxH ? rect.bottom + 2 : Math.max(8, rect.top - maxH - 2);
    // Inside a dialog whose backdrop is blurred (the Review Desk), "fixed"
    // is relative to that backdrop, not to the window.
    const origin = fixedOrigin(anchor);
    setFixedStyle({
      top: `${top - origin.top}px`,
      left: `${rect.left + 8 - origin.left}px`,
      width: `${rect.width - 16}px`,
    });
  }, [triggerRef]);

  const contextBranchRef = useRef<GitBranch | null>(null);

  const handleBranchAction = useCallback((actionId: string) => {
    const branch = contextBranchRef.current;
    if (!branch) return;
    switch (actionId) {
      case "branch.checkout":
        if (confirmSwitch) {
          setPendingSwitch(branch.name);
          break;
        }
        gitCheckoutBranch(sessionId, projectId, branch.name)
          .then(() => { onRefresh(); onToast(`Checked out ${branch.name}`, "success"); })
          .catch((e) => onToast(String(e), "error"));
        break;
      case "branch.copy-name":
        navigator.clipboard.writeText(branch.name).catch(console.error);
        break;
      case "branch.delete":
        gitDeleteBranch(sessionId, projectId, branch.name, false)
          .then(() => { onRefresh(); onToast(`Deleted ${branch.name}`, "success"); })
          .catch((e) => {
            const u = parseUnmergedBranch(e);
            if (u) setUnmerged(u);
            else onToast(gitErrorMessage(e), "error");
          });
        break;
    }
  }, [sessionId, projectId, onRefresh, onToast, confirmSwitch]);

  const { showMenu: showBranchMenu } = useContextMenu(handleBranchAction);

  const loadBranches = useCallback(async () => {
    try {
      setLoading(true);
      const result = await gitListBranches(sessionId, projectId);
      setBranches(result);
      // Lazily enrich ahead/behind counts in the background after initial render
      gitBranchesAheadBehind(sessionId, projectId)
        .then((aheadBehind) => {
          setBranches((prev) =>
            prev.map((b) => {
              const ab = aheadBehind[b.name];
              return ab ? { ...b, ahead: ab[0], behind: ab[1] } : b;
            }),
          );
        })
        .catch(() => { /* non-critical — branches still usable without ahead/behind */ });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, projectId]);

  useEffect(() => {
    loadBranches();
  }, [loadBranches]);

  // Focus search on open
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Use timeout to avoid the click that opened the selector
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Auto-dismiss errors
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const doCheckout = useCallback(async (name: string) => {
    try {
      setError(null);
      setPendingSwitch(null);
      const result = await gitCheckoutBranch(sessionId, projectId, name);
      onToast(result.message);
      onRefresh();
      onClose();
    } catch (e) {
      setError(gitErrorMessage(e));
    }
  }, [sessionId, projectId, onRefresh, onToast, onClose]);

  /** One click switches, unless a task's worktree or an agent's folder would move: then ask. */
  const handleCheckout = useCallback((name: string) => {
    if (confirmSwitch) {
      setPendingSwitch(name);
      return;
    }
    void doCheckout(name);
  }, [confirmSwitch, doCheckout]);

  const handleCreate = useCallback(async () => {
    const validationError = validateBranchName(newName);
    if (validationError) {
      setError(validationError);
      return;
    }
    // An existing branch, also when only the letter case differs (on macOS
    // and Windows `Develop` IS `develop`): said here, before git is asked.
    const clash = findBranchClash(newName.trim(), branches.filter((b) => !b.is_remote).map((b) => b.name));
    if (clash) {
      setError(branchClashMessage(clash));
      return;
    }
    try {
      setError(null);
      const result = await gitCreateBranch(sessionId, projectId, newName.trim(), true);
      onToast(result.message);
      setNewName("");
      setCreating(false);
      onRefresh();
      onClose();
    } catch (e) {
      setError(gitErrorMessage(e));
    }
  }, [sessionId, projectId, newName, branches, onRefresh, onToast, onClose]);

  const handleDelete = useCallback(async (name: string, force: boolean) => {
    try {
      setError(null);
      const result = await gitDeleteBranch(sessionId, projectId, name, force);
      onToast(result.message);
      setConfirmDelete(null);
      setUnmerged(null);
      loadBranches();
      onRefresh();
    } catch (e) {
      // Commits only this branch has: ask (Keep / Delete anyway), never a
      // message about an option the switcher does not have.
      const u = parseUnmergedBranch(e);
      setConfirmDelete(null);
      if (u) setUnmerged(u);
      else setError(gitErrorMessage(e));
    }
  }, [sessionId, projectId, onRefresh, onToast, loadBranches]);

  const filtered = filterBranches(branches, search);
  const { local, remote } = groupBranches(filtered);

  return (
    <div className="git-branch-selector" ref={containerRef} style={fixedStyle}>
      <input
        ref={searchRef}
        className="git-branch-search"
        placeholder="Search branches..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {loading && <div className="git-empty">Loading branches...</div>}

      {!loading && (
        <div className="git-branch-list">
          {local.length > 0 && (
            <div className="git-branch-group">
              <div className="git-file-group-label" style={{ padding: "4px 8px" }}>LOCAL</div>
              {local.map((b) => (
                <div
                  key={b.name}
                  className={`git-branch-item ${b.is_current ? "git-branch-item-current" : ""}`}
                  onClick={() => !b.is_current && handleCheckout(b.name)}
                  onContextMenu={(e) => { contextBranchRef.current = b; showBranchMenu(e, buildBranchMenuItems({ name: b.name, is_remote: b.is_remote }, currentBranch || "")); }}
                >
                  <span className="git-branch-item-name">
                    {b.is_current && <span className="git-branch-current-marker">*</span>}
                    {b.name}
                  </span>
                  {b.ahead > 0 && <span className="git-project-ahead">&uarr;{b.ahead}</span>}
                  {b.behind > 0 && <span className="git-project-behind">&darr;{b.behind}</span>}
                  {!b.is_current && (
                    confirmDelete === b.name ? (
                      <span className="git-branch-confirm-delete">
                        <button className="git-branch-delete-yes" onClick={(e) => { e.stopPropagation(); handleDelete(b.name, false); }} title="Confirm delete">Yes</button>
                        <button className="git-branch-delete-no" onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }} title="Cancel">No</button>
                      </span>
                    ) : (
                      <button
                        className="git-branch-delete"
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(b.name); }}
                        title="Delete branch"
                      >&times;</button>
                    )
                  )}
                </div>
              ))}
            </div>
          )}

          {remote.length > 0 && (
            <div className="git-branch-group">
              <div className="git-file-group-label" style={{ padding: "4px 8px" }}>REMOTE</div>
              {remote.map((b) => (
                <div
                  key={b.name}
                  className="git-branch-item git-branch-item-remote"
                  onClick={() => handleCheckout(b.name)}
                  onContextMenu={(e) => { contextBranchRef.current = b; showBranchMenu(e, buildBranchMenuItems({ name: b.name, is_remote: b.is_remote }, currentBranch || "")); }}
                >
                  <span className="git-branch-item-name">{b.name}</span>
                </div>
              ))}
            </div>
          )}

          {local.length === 0 && remote.length === 0 && !loading && (
            <div className="git-empty">No matching branches</div>
          )}
        </div>
      )}

      {error && <div className="git-error" style={{ margin: "4px 8px" }}>{error}</div>}

      {pendingSwitch && (
        <div className="git-branch-ask git-branch-switch-confirm" role="alertdialog" aria-labelledby="git-branch-switch-text">
          <div className="git-branch-ask-text" id="git-branch-switch-text">
            {confirmSwitch === "agent-folder"
              ? t("branchSwitch.agentFolder", { from: currentBranch ?? "", to: pendingSwitch, agent: agentName || t("branchSwitch.theAgent") })
              : t("branchSwitch.taskWorktree", { from: currentBranch ?? "", to: pendingSwitch })}
          </div>
          <div className="git-branch-ask-actions">
            <Button size="sm" className="git-branch-switch-cancel" onClick={() => setPendingSwitch(null)}>
              {t("common.cancel")}
            </Button>
            <Button size="sm" variant="primary" className="git-branch-switch-yes" onClick={() => void doCheckout(pendingSwitch)}>
              {t("branchSwitch.switch")}
            </Button>
          </div>
        </div>
      )}

      {unmerged && (
        <div className="git-branch-ask git-branch-unmerged" role="alert">
          <div className="git-branch-ask-text">
            {t(unmerged.commits === 1 ? "branchDelete.unmergedOne" : "branchDelete.unmergedMany", {
              branch: unmerged.branch,
              count: unmerged.commits,
              base: unmerged.base,
            })}
          </div>
          <div className="git-branch-ask-actions">
            <Button size="sm" className="git-branch-unmerged-keep" onClick={() => setUnmerged(null)}>
              {t("branchDelete.keep")}
            </Button>
            <Button size="sm" variant="danger" className="git-branch-unmerged-delete" onClick={() => void handleDelete(unmerged.branch, true)}>
              {t("branchDelete.deleteAnyway")}
            </Button>
          </div>
        </div>
      )}

      <div className="git-branch-create-area">
        {creating ? (
          <div className="git-branch-create-input-row">
            <input
              className="git-branch-create-input"
              placeholder="new-branch-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") { setCreating(false); setNewName(""); }
              }}
              autoFocus
            />
            <button className="git-btn" onClick={handleCreate} style={{ flex: "none", padding: "2px 8px" }}>Create</button>
          </div>
        ) : (
          <button className="git-branch-new-btn" onClick={() => setCreating(true)}>+ New Branch</button>
        )}
      </div>
    </div>
  );
}
