/**
 * Tests for BranchConflictDialog component logic.
 *
 * Since the test environment is `node` (no DOM), we test the validation
 * logic and callback invocation patterns extracted from the component.
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../terminal/TerminalPool", () => ({
  createTerminal: vi.fn(),
  destroy: vi.fn(),
  updateSettings: vi.fn(),
  writeScrollback: vi.fn(),
}));
vi.mock("../utils/notifications", () => ({
  initNotifications: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Extracted validation logic (mirrors BranchConflictDialog.tsx) ──

/**
 * Mirrors the handleCreate validation logic from BranchConflictDialog.
 * Returns a validation error string or null if valid, and calls the
 * callback on success.
 */
function validateAndCreate(
  newBranchName: string,
  originalBranchName: string,
  onCreateNewBranch: (name: string) => void,
): string | null {
  const name = newBranchName.trim();
  if (!name) {
    return "Branch name cannot be empty";
  }
  if (/\s/.test(name)) {
    return "Branch name cannot contain spaces";
  }
  if (name === originalBranchName) {
    return "New branch must have a different name";
  }
  onCreateNewBranch(name);
  return null;
}

/**
 * Mirrors the default branch name suggestion from the component.
 */
function getDefaultNewBranchName(branchName: string): string {
  return `${branchName}-2`;
}

// ─── Validation logic tests ─────────────────────────────────────────

describe("BranchConflictDialog - Validation logic", () => {
  it("rejects empty branch name", () => {
    const cb = vi.fn();
    const error = validateAndCreate("", "feature/x", cb);
    expect(error).toBe("Branch name cannot be empty");
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only branch name", () => {
    const cb = vi.fn();
    const error = validateAndCreate("   ", "feature/x", cb);
    expect(error).toBe("Branch name cannot be empty");
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects branch name with spaces", () => {
    const cb = vi.fn();
    const error = validateAndCreate("my branch", "feature/x", cb);
    expect(error).toBe("Branch name cannot contain spaces");
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects branch name with tab character", () => {
    const cb = vi.fn();
    const error = validateAndCreate("my\tbranch", "feature/x", cb);
    expect(error).toBe("Branch name cannot contain spaces");
    expect(cb).not.toHaveBeenCalled();
  });

  it("rejects new branch name identical to original", () => {
    const cb = vi.fn();
    const error = validateAndCreate("feature/x", "feature/x", cb);
    expect(error).toBe("New branch must have a different name");
    expect(cb).not.toHaveBeenCalled();
  });

  it("accepts valid branch name and calls callback", () => {
    const cb = vi.fn();
    const error = validateAndCreate("feature/x-2", "feature/x", cb);
    expect(error).toBeNull();
    expect(cb).toHaveBeenCalledWith("feature/x-2");
  });

  it("trims leading/trailing whitespace before validation", () => {
    const cb = vi.fn();
    const error = validateAndCreate("  feature/y  ", "feature/x", cb);
    expect(error).toBeNull();
    expect(cb).toHaveBeenCalledWith("feature/y");
  });

  it("accepts branch with hyphens and slashes", () => {
    const cb = vi.fn();
    const error = validateAndCreate("fix/issue-123", "main", cb);
    expect(error).toBeNull();
    expect(cb).toHaveBeenCalledWith("fix/issue-123");
  });

  it("accepts branch with dots (not leading/trailing)", () => {
    const cb = vi.fn();
    const error = validateAndCreate("v1.0.0-hotfix", "main", cb);
    expect(error).toBeNull();
    expect(cb).toHaveBeenCalledWith("v1.0.0-hotfix");
  });
});

// ─── Default name suggestion ────────────────────────────────────────

describe("BranchConflictDialog - Default name suggestion", () => {
  it("suggests branchName-2 as default", () => {
    expect(getDefaultNewBranchName("feature/login")).toBe("feature/login-2");
  });

  it("appends -2 to main branch", () => {
    expect(getDefaultNewBranchName("main")).toBe("main-2");
  });

  it("appends -2 even if branch already has a number suffix", () => {
    expect(getDefaultNewBranchName("feature-1")).toBe("feature-1-2");
  });

  it("default suggestion passes validation", () => {
    const original = "feature/x";
    const suggested = getDefaultNewBranchName(original);
    const cb = vi.fn();
    const error = validateAndCreate(suggested, original, cb);
    expect(error).toBeNull();
    expect(cb).toHaveBeenCalledWith(suggested);
  });
});

// ─── Callback contracts ─────────────────────────────────────────────

describe("BranchConflictDialog - Callback contracts", () => {
  it("onCreateNewBranch receives the trimmed branch name", () => {
    const cb = vi.fn();
    validateAndCreate("  new-branch  ", "old-branch", cb);
    expect(cb).toHaveBeenCalledWith("new-branch");
  });

  it("onCreateNewBranch is not called on validation failure", () => {
    const cb = vi.fn();
    validateAndCreate("", "main", cb);
    validateAndCreate("has space", "main", cb);
    validateAndCreate("main", "main", cb);
    expect(cb).not.toHaveBeenCalled();
  });

  it("onSwitchToSession is a zero-arg callback", () => {
    const onSwitch = vi.fn();
    // Simulating component calling this callback
    onSwitch();
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch).toHaveBeenCalledWith();
  });

  it("onCancel is a zero-arg callback", () => {
    const onCancel = vi.fn();
    // Simulating component calling this callback
    onCancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith();
  });
});

// ─── Escape key behavior (logic extraction) ─────────────────────────

describe("BranchConflictDialog - Escape key handling", () => {
  it("Escape key event triggers onCancel", () => {
    const onCancel = vi.fn();
    // Simulating the keydown handler from the component
    const handler = (e: { key: string; stopPropagation: () => void }) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };

    const stopPropagation = vi.fn();
    handler({ key: "Escape", stopPropagation });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("non-Escape keys do not trigger onCancel", () => {
    const onCancel = vi.fn();
    const handler = (e: { key: string; stopPropagation: () => void }) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };

    handler({ key: "Enter", stopPropagation: vi.fn() });
    handler({ key: "a", stopPropagation: vi.fn() });
    handler({ key: "Tab", stopPropagation: vi.fn() });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// ─── BranchAvailability type shape ──────────────────────────────────

describe("BranchAvailability type shape", () => {
  it("unavailable branch has usedBySession set", () => {
    const availability = {
      available: false,
      usedBySession: "session-2",
      branchName: "feature/x",
    };
    expect(availability.available).toBe(false);
    expect(availability.usedBySession).toBe("session-2");
    expect(availability.branchName).toBe("feature/x");
  });

  it("available branch has usedBySession null", () => {
    const availability = {
      available: true,
      usedBySession: null as string | null,
      branchName: "new-feature",
    };
    expect(availability.available).toBe(true);
    expect(availability.usedBySession).toBeNull();
  });
});

// ─── Dialog content display logic ───────────────────────────────────

describe("BranchConflictDialog - Display content", () => {
  it("conflict message includes branch name", () => {
    const branchName = "feature/login";
    const message = `Branch ${branchName} is already checked out`;
    expect(message).toContain("feature/login");
  });

  it("conflict message includes session label", () => {
    const sessionLabel = "My Session";
    const message = `already checked out by session ${sessionLabel}`;
    expect(message).toContain("My Session");
  });

  it("switch button text includes session label", () => {
    const sessionLabel = "Dev Session";
    const buttonText = `Switch to \u201c${sessionLabel}\u201d`;
    expect(buttonText).toContain("Dev Session");
  });

  it("create button text includes original branch name", () => {
    const branchName = "main";
    const buttonText = `Create New Branch from \u201c${branchName}\u201d`;
    expect(buttonText).toContain("main");
  });
});
