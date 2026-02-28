import { useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { GitBranch } from "../types/git";
import { gitListBranches, gitCreateBranch, gitCheckoutBranch, gitDeleteBranch } from "../api/git";
import type { GitToast } from "./GitPanel";
import { useContextMenu, buildBranchMenuItems } from "../hooks/useContextMenu";

interface GitBranchSelectorProps {
  projectPath: string;
  currentBranch: string | null;
  onRefresh: () => void;
  onToast: (message: string, type?: GitToast["type"]) => void;
  onClose: () => void;
  /** Ref to the element that triggered the dropdown, used for fixed positioning */
  triggerRef?: React.RefObject<HTMLElement | null>;
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

export function GitBranchSelector({ projectPath, currentBranch, onRefresh, onToast, onClose, triggerRef }: GitBranchSelectorProps) {
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
    setFixedStyle({
      top: `${top}px`,
      left: `${rect.left + 8}px`,
      width: `${rect.width - 16}px`,
    });
  }, [triggerRef]);

  const contextBranchRef = useRef<GitBranch | null>(null);

  const handleBranchAction = useCallback((actionId: string) => {
    const branch = contextBranchRef.current;
    if (!branch) return;
    switch (actionId) {
      case "branch.checkout":
        gitCheckoutBranch(projectPath, branch.name)
          .then(() => { onRefresh(); onToast(`Checked out ${branch.name}`, "success"); })
          .catch((e) => onToast(String(e), "error"));
        break;
      case "branch.copy-name":
        navigator.clipboard.writeText(branch.name).catch(console.error);
        break;
      case "branch.delete":
        gitDeleteBranch(projectPath, branch.name, false)
          .then(() => { onRefresh(); onToast(`Deleted ${branch.name}`, "success"); })
          .catch((e) => onToast(String(e), "error"));
        break;
    }
  }, [projectPath, onRefresh, onToast]);

  const { showMenu: showBranchMenu } = useContextMenu(handleBranchAction);

  const loadBranches = useCallback(async () => {
    try {
      setLoading(true);
      const result = await gitListBranches(projectPath);
      setBranches(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

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

  const handleCheckout = useCallback(async (name: string) => {
    try {
      setError(null);
      const result = await gitCheckoutBranch(projectPath, name);
      onToast(result.message);
      onRefresh();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath, onRefresh, onToast, onClose]);

  const handleCreate = useCallback(async () => {
    const validationError = validateBranchName(newName);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      setError(null);
      const result = await gitCreateBranch(projectPath, newName.trim(), true);
      onToast(result.message);
      setNewName("");
      setCreating(false);
      onRefresh();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath, newName, onRefresh, onToast, onClose]);

  const handleDelete = useCallback(async (name: string, force: boolean) => {
    try {
      setError(null);
      const result = await gitDeleteBranch(projectPath, name, force);
      onToast(result.message);
      setConfirmDelete(null);
      loadBranches();
      onRefresh();
    } catch (e) {
      setError(String(e));
    }
  }, [projectPath, onRefresh, onToast, loadBranches]);

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
