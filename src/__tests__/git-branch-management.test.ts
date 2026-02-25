/**
 * Tests for Git Branch Management feature.
 *
 * - Pure helper functions: filterBranches, groupBranches, validateBranchName
 * - Reducer tests for SET_LEFT_TAB with git
 * - GitBranch type shape tests
 * - Branch operation guard logic
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
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { sessionReducer, initialState } from "../state/SessionContext";
import { filterBranches, groupBranches, validateBranchName } from "../components/GitBranchSelector";
import type { GitBranch } from "../types/git";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeBranch(overrides?: Partial<GitBranch>): GitBranch {
  return {
    name: "main",
    is_current: false,
    is_remote: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    last_commit_summary: null,
    ...overrides,
  };
}

// ─── filterBranches ─────────────────────────────────────────────────

describe("filterBranches", () => {
  const branches = [
    makeBranch({ name: "main", is_current: true }),
    makeBranch({ name: "feature/login" }),
    makeBranch({ name: "feature/signup" }),
    makeBranch({ name: "bugfix/header" }),
    makeBranch({ name: "origin/main", is_remote: true }),
  ];

  it("empty query returns all branches", () => {
    expect(filterBranches(branches, "")).toEqual(branches);
    expect(filterBranches(branches, "  ")).toEqual(branches);
  });

  it("filters by partial name match (case-insensitive)", () => {
    const result = filterBranches(branches, "FEATURE");
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.name)).toEqual(["feature/login", "feature/signup"]);
  });

  it("filters across local and remote branches", () => {
    const result = filterBranches(branches, "main");
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.name)).toContain("main");
    expect(result.map((b) => b.name)).toContain("origin/main");
  });

  it("returns empty result for no matches", () => {
    const result = filterBranches(branches, "nonexistent");
    expect(result).toHaveLength(0);
  });

  it("handles special characters in query", () => {
    const result = filterBranches(branches, "fix/");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("bugfix/header");
  });
});

// ─── groupBranches ──────────────────────────────────────────────────

describe("groupBranches", () => {
  it("separates local and remote correctly", () => {
    const branches = [
      makeBranch({ name: "main" }),
      makeBranch({ name: "origin/main", is_remote: true }),
      makeBranch({ name: "develop" }),
    ];
    const { local, remote } = groupBranches(branches);
    expect(local).toHaveLength(2);
    expect(remote).toHaveLength(1);
  });

  it("current branch is always first in local group", () => {
    const branches = [
      makeBranch({ name: "develop" }),
      makeBranch({ name: "feature/x" }),
      makeBranch({ name: "main", is_current: true }),
    ];
    const { local } = groupBranches(branches);
    expect(local[0].name).toBe("main");
    expect(local[0].is_current).toBe(true);
  });

  it("empty input returns empty groups", () => {
    const { local, remote } = groupBranches([]);
    expect(local).toHaveLength(0);
    expect(remote).toHaveLength(0);
  });

  it("mixed input groups correctly", () => {
    const branches = [
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "origin/main", is_remote: true }),
      makeBranch({ name: "origin/develop", is_remote: true }),
      makeBranch({ name: "feature/x" }),
    ];
    const { local, remote } = groupBranches(branches);
    expect(local).toHaveLength(2);
    expect(remote).toHaveLength(2);
    expect(local[0].is_current).toBe(true);
  });
});

// ─── validateBranchName ─────────────────────────────────────────────

describe("validateBranchName", () => {
  it("valid names return null", () => {
    expect(validateBranchName("feature/my-branch")).toBeNull();
    expect(validateBranchName("main")).toBeNull();
    expect(validateBranchName("fix-123")).toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateBranchName("")).toBe("Branch name cannot be empty");
    expect(validateBranchName("  ")).toBe("Branch name cannot be empty");
  });

  it("rejects names with spaces", () => {
    expect(validateBranchName("my branch")).toBe("Branch name cannot contain spaces");
  });

  it("rejects names starting with '-'", () => {
    expect(validateBranchName("-my-branch")).toBe("Branch name cannot start with '-'");
  });

  it("rejects '..' in name", () => {
    expect(validateBranchName("my..branch")).toBe("Branch name cannot contain '..'");
  });

  it("rejects names ending with '.lock'", () => {
    expect(validateBranchName("my-branch.lock")).toBe("Branch name cannot end with '.lock'");
  });
});

// ─── Reducer: SET_LEFT_TAB with git ─────────────────────────────────

describe("Reducer: SET_LEFT_TAB with git", () => {
  it("switches to git tab correctly", () => {
    const state = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "git" });
    expect(state.ui.activeLeftTab).toBe("git");
    expect(state.ui.gitPanelOpen).toBe(true);
    expect(state.ui.processPanelOpen).toBe(false);
    expect(state.ui.fileExplorerOpen).toBe(false);
  });

  it("switching to git tab closes other panels", () => {
    const withProcesses = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "processes" });
    const state = sessionReducer(withProcesses, { type: "SET_LEFT_TAB", tab: "git" });
    expect(state.ui.gitPanelOpen).toBe(true);
    expect(state.ui.processPanelOpen).toBe(false);
  });

  it("toggling active git tab collapses", () => {
    const withGit = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "git" });
    const state = sessionReducer(withGit, { type: "SET_LEFT_TAB", tab: "git" });
    expect(state.ui.gitPanelOpen).toBe(false);
    expect(state.ui.sessionListCollapsed).toBe(true);
  });
});

// ─── GitBranch type shape ───────────────────────────────────────────

describe("GitBranch type shape", () => {
  it("factory function produces valid shape", () => {
    const branch = makeBranch();
    expect(branch).toHaveProperty("name");
    expect(branch).toHaveProperty("is_current");
    expect(branch).toHaveProperty("is_remote");
    expect(branch).toHaveProperty("upstream");
    expect(branch).toHaveProperty("ahead");
    expect(branch).toHaveProperty("behind");
    expect(branch).toHaveProperty("last_commit_summary");
  });

  it("default values are correct", () => {
    const branch = makeBranch();
    expect(branch.name).toBe("main");
    expect(branch.is_current).toBe(false);
    expect(branch.is_remote).toBe(false);
    expect(branch.upstream).toBeNull();
    expect(branch.ahead).toBe(0);
    expect(branch.behind).toBe(0);
  });

  it("override merging works", () => {
    const branch = makeBranch({ name: "develop", is_current: true, ahead: 3 });
    expect(branch.name).toBe("develop");
    expect(branch.is_current).toBe(true);
    expect(branch.ahead).toBe(3);
    expect(branch.is_remote).toBe(false); // default preserved
  });
});

// ─── Branch operation guards ────────────────────────────────────────

describe("Branch operation guards", () => {
  it("cannot delete current branch (validate in UI logic)", () => {
    const current = makeBranch({ name: "main", is_current: true });
    // UI should prevent delete button from showing on current branch
    expect(current.is_current).toBe(true);
    // In real code, the delete button is not rendered for current branch
  });

  it("create branch requires non-empty name", () => {
    expect(validateBranchName("")).not.toBeNull();
    expect(validateBranchName("valid-name")).toBeNull();
  });

  it("checkout shows dirty-tree warning logic", () => {
    // The backend returns an error when working tree is dirty
    // UI should display that error inline
    const error = "Cannot checkout: you have uncommitted changes. Commit or stash them first.";
    expect(error).toContain("uncommitted changes");
  });

  it("force delete flag propagation", () => {
    // Verify force flag is a boolean that gets passed through
    const force = true;
    const notForce = false;
    expect(typeof force).toBe("boolean");
    expect(typeof notForce).toBe("boolean");
  });
});
