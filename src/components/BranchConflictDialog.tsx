import { useState, useEffect, useCallback } from "react";
import "../styles/components/BranchConflictDialog.css";
import { Button, CloseButton, Input } from "./ui";

interface BranchConflictDialogProps {
  branchName: string;
  /** Who has the branch checked out, e.g. `session "Fix login"` or `the project folder`. */
  heldBy: string;
  /** Folder where it is checked out. */
  path: string;
  onReuse: () => void;
  onCreateNewBranch: (newBranchName: string) => void;
  onCancel: () => void;
}

/** Validation for the "use another branch" name. Null when the name is usable. */
export function validateNewBranchName(name: string, inUse: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Branch name cannot be empty";
  if (/\s/.test(trimmed)) return "Branch name cannot contain spaces";
  if (trimmed === inUse) return "New branch must have a different name";
  return null;
}

/**
 * Blocking choice shown when a new session asks for a branch that is
 * already checked out somewhere else. Hermes never shares a checkout on
 * its own; the user picks one of:
 *
 *  1. Reuse that checkout (both sessions then edit the same files)
 *  2. Use a new branch, `<branch>-2` by default, cut from that branch
 *  3. Cancel creating the session
 *
 * Clicking outside does nothing: one of the three must be chosen.
 */
export function BranchConflictDialog({
  branchName,
  heldBy,
  path,
  onReuse,
  onCreateNewBranch,
  onCancel,
}: BranchConflictDialogProps) {
  const [newBranchName, setNewBranchName] = useState(`${branchName}-2`);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Escape = Cancel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const handleCreate = useCallback(() => {
    const error = validateNewBranchName(newBranchName, branchName);
    setValidationError(error);
    if (!error) onCreateNewBranch(newBranchName.trim());
  }, [newBranchName, branchName, onCreateNewBranch]);

  return (
    <div className="branch-conflict-overlay">
      <div
        className="branch-conflict-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="branch-conflict-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="branch-conflict-header">
          <span className="branch-conflict-icon">&#9888;</span>
          <span className="branch-conflict-title" id="branch-conflict-title">Branch In Use</span>
          <CloseButton className="branch-conflict-close" onClick={onCancel} label="Close" />
        </div>

        <div className="branch-conflict-body">
          <p className="branch-conflict-message">
            Branch <strong className="branch-conflict-branch-name">{branchName}</strong> is
            already checked out by{" "}
            <strong className="branch-conflict-session-name">{heldBy}</strong>.
          </p>
          <p className="branch-conflict-path" title={path}>
            <code>{path}</code>
          </p>
          <p className="branch-conflict-hint">
            Two sessions on one checkout edit the same files. Choose what this session should do:
          </p>

          <div className="branch-conflict-actions">
            <div className="branch-conflict-create-row">
              <Input
                code
                className="branch-conflict-create-input"
                aria-label="New branch name"
                value={newBranchName}
                onChange={(e) => {
                  setNewBranchName(e.target.value);
                  setValidationError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
                placeholder="new-branch-name"
                invalid={!!validationError}
                aria-describedby={validationError ? "branch-conflict-error" : undefined}
                autoFocus
              />
              <Button variant="primary" className="branch-conflict-btn-create" onClick={handleCreate}>
                Use new branch
              </Button>
            </div>

            {validationError && (
              <div id="branch-conflict-error" className="branch-conflict-error" role="alert">
                {validationError}
              </div>
            )}

            <div className="branch-conflict-other-row">
              <Button variant="quiet" className="branch-conflict-btn-cancel" onClick={onCancel}>
                Cancel
              </Button>
              <Button className="branch-conflict-btn-switch" onClick={onReuse}>
                Reuse its checkout
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
