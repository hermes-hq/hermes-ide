/**
 * Integration-style tests for the git worktree system.
 *
 * Tests the interaction patterns between worktree API functions,
 * branch availability checking, and multi-session scenarios.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
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

// ─── Imports ─────────────────────────────────────────────────────────
import { invoke } from "@tauri-apps/api/core";
import {
  createWorktree,
  removeWorktree,
  listWorktrees,
  checkBranchAvailable,
  getSessionWorktreeInfo,
  gitCheckoutBranch,
  gitListBranches,
} from "../api/git";
import type {
  WorktreeInfo,
  WorktreeCreateResult,
  BranchAvailability,
  SessionWorktree,
  GitBranch,
} from "../types/git";

// ─── Helpers ────────────────────────────────────────────────────────

function makeWorktreeInfo(overrides?: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    sessionId: "session-1",
    sessionLabel: "Session 1",
    branchName: "main",
    worktreePath: "/repos/main",
    isMainWorktree: true,
    ...overrides,
  };
}

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

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

// ─── Session lifecycle with worktrees ───────────────────────────────

describe("Session creation with worktree", () => {
  it("createWorktree returns worktree path and branch info", async () => {
    const createResult: WorktreeCreateResult = {
      worktreePath: "/repos/.worktrees/feature-login",
      branchName: "feature/login",
      isMainWorktree: false,
    };
    vi.mocked(invoke).mockResolvedValue(createResult);

    const result = await createWorktree("session-2", "project-1", "feature/login", true);
    expect(result.worktreePath).toBe("/repos/.worktrees/feature-login");
    expect(result.branchName).toBe("feature/login");
    expect(result.isMainWorktree).toBe(false);
  });

  it("first session gets main worktree", async () => {
    const createResult: WorktreeCreateResult = {
      worktreePath: "/repos/myproject",
      branchName: "main",
      isMainWorktree: true,
    };
    vi.mocked(invoke).mockResolvedValue(createResult);

    const result = await createWorktree("session-1", "project-1", "main", false);
    expect(result.isMainWorktree).toBe(true);
  });

  it("second session on same repo gets linked worktree", async () => {
    const createResult: WorktreeCreateResult = {
      worktreePath: "/repos/.worktrees/develop",
      branchName: "develop",
      isMainWorktree: false,
    };
    vi.mocked(invoke).mockResolvedValue(createResult);

    const result = await createWorktree("session-2", "project-1", "develop", false);
    expect(result.isMainWorktree).toBe(false);
    expect(result.worktreePath).not.toBe("/repos/myproject"); // different path
  });
});

describe("Session destruction with worktree", () => {
  it("removeWorktree cleans up worktree on session close", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "Worktree removed", error: null });

    const result = await removeWorktree("session-2", "project-1");
    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith("git_remove_worktree", {
      sessionId: "session-2",
      projectId: "project-1",
    });
  });

  it("removeWorktree fails gracefully for non-existent worktree", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: false, message: "No worktree", error: "not found" });

    const result = await removeWorktree("session-99", "project-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("not found");
  });
});

// ─── Branch availability checking ───────────────────────────────────

describe("Branch checkout validates availability first", () => {
  it("available branch can be checked out", async () => {
    // First check availability
    vi.mocked(invoke).mockResolvedValueOnce({
      available: true,
      usedBySession: null,
      branchName: "feature/x",
    } satisfies BranchAvailability);

    const availability = await checkBranchAvailable("project-1", "feature/x");
    expect(availability.available).toBe(true);

    // Then checkout
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, message: "checked out", error: null });
    const result = await gitCheckoutBranch("s1", "project-1", "feature/x");
    expect(result.success).toBe(true);
  });

  it("unavailable branch reports which session is using it", async () => {
    vi.mocked(invoke).mockResolvedValue({
      available: false,
      usedBySession: "session-2",
      branchName: "feature/x",
    } satisfies BranchAvailability);

    const availability = await checkBranchAvailable("project-1", "feature/x");
    expect(availability.available).toBe(false);
    expect(availability.usedBySession).toBe("session-2");
  });

  it("checkout should be guarded by availability check", async () => {
    // Simulate the pattern: check -> guard -> checkout
    vi.mocked(invoke)
      .mockResolvedValueOnce({
        available: false,
        usedBySession: "session-3",
        branchName: "develop",
      } satisfies BranchAvailability);

    const availability = await checkBranchAvailable("project-1", "develop");

    // If unavailable, do NOT proceed with checkout
    if (!availability.available) {
      // In real code, BranchConflictDialog would be shown
      expect(availability.usedBySession).toBe("session-3");
      expect(invoke).toHaveBeenCalledTimes(1); // only the check, no checkout
      return;
    }

    // This should not be reached
    expect(true).toBe(false);
  });
});

// ─── Multi-session worktree listing ─────────────────────────────────

describe("Multiple sessions on same repo get different worktree paths", () => {
  it("listWorktrees shows all sessions and their branches", async () => {
    const worktrees: WorktreeInfo[] = [
      makeWorktreeInfo({
        sessionId: "session-1",
        sessionLabel: "Session 1",
        branchName: "main",
        worktreePath: "/repos/myproject",
        isMainWorktree: true,
      }),
      makeWorktreeInfo({
        sessionId: "session-2",
        sessionLabel: "Session 2",
        branchName: "feature/login",
        worktreePath: "/repos/.worktrees/feature-login",
        isMainWorktree: false,
      }),
      makeWorktreeInfo({
        sessionId: "session-3",
        sessionLabel: "Session 3",
        branchName: "hotfix/bug-42",
        worktreePath: "/repos/.worktrees/hotfix-bug-42",
        isMainWorktree: false,
      }),
    ];

    vi.mocked(invoke).mockResolvedValue(worktrees);

    const result = await listWorktrees("project-1");
    expect(result).toHaveLength(3);

    // All sessions have unique paths
    const paths = result.map((w) => w.worktreePath);
    expect(new Set(paths).size).toBe(3);

    // All sessions have unique branches
    const branches = result.map((w) => w.branchName);
    expect(new Set(branches).size).toBe(3);

    // Exactly one main worktree
    const mainWorktrees = result.filter((w) => w.isMainWorktree);
    expect(mainWorktrees).toHaveLength(1);
    expect(mainWorktrees[0].sessionId).toBe("session-1");
  });

  it("each session has its own worktree info", async () => {
    const session1Info: SessionWorktree = {
      id: "wt-1",
      sessionId: "session-1",
      projectId: "project-1",
      worktreePath: "/repos/myproject",
      branchName: "main",
      isMainWorktree: true,
      createdAt: "2026-01-01T00:00:00Z",
    };

    const session2Info: SessionWorktree = {
      id: "wt-2",
      sessionId: "session-2",
      projectId: "project-1",
      worktreePath: "/repos/.worktrees/develop",
      branchName: "develop",
      isMainWorktree: false,
      createdAt: "2026-01-02T00:00:00Z",
    };

    // Query session 1
    vi.mocked(invoke).mockResolvedValueOnce(session1Info);
    const info1 = await getSessionWorktreeInfo("session-1", "project-1");
    expect(info1!.worktreePath).toBe("/repos/myproject");
    expect(info1!.isMainWorktree).toBe(true);

    // Query session 2
    vi.mocked(invoke).mockResolvedValueOnce(session2Info);
    const info2 = await getSessionWorktreeInfo("session-2", "project-1");
    expect(info2!.worktreePath).toBe("/repos/.worktrees/develop");
    expect(info2!.isMainWorktree).toBe(false);

    // Different paths
    expect(info1!.worktreePath).not.toBe(info2!.worktreePath);
  });
});

// ─── Branch availability vs. worktree checked-out branches ──────────

describe("Unavailable branches shown as disabled", () => {
  it("checked-out branches in worktrees are marked unavailable", async () => {
    // List all worktrees to find checked-out branches
    const worktrees: WorktreeInfo[] = [
      makeWorktreeInfo({ branchName: "main", sessionId: "s1" }),
      makeWorktreeInfo({ branchName: "develop", sessionId: "s2", isMainWorktree: false }),
    ];
    vi.mocked(invoke).mockResolvedValueOnce(worktrees);

    const wts = await listWorktrees("project-1");
    const checkedOut = new Set(wts.map((w) => w.branchName).filter(Boolean));

    expect(checkedOut.has("main")).toBe(true);
    expect(checkedOut.has("develop")).toBe(true);
    expect(checkedOut.has("feature/new")).toBe(false);
  });

  it("available branches can be filtered from branch list", async () => {
    // First get worktrees
    const worktrees: WorktreeInfo[] = [
      makeWorktreeInfo({ branchName: "main", sessionId: "s1" }),
      makeWorktreeInfo({ branchName: "develop", sessionId: "s2", isMainWorktree: false }),
    ];

    // Then get branch list
    const branches: GitBranch[] = [
      makeBranch({ name: "main", is_current: true }),
      makeBranch({ name: "develop" }),
      makeBranch({ name: "feature/x" }),
      makeBranch({ name: "feature/y" }),
      makeBranch({ name: "origin/main", is_remote: true }),
    ];

    vi.mocked(invoke)
      .mockResolvedValueOnce(worktrees)
      .mockResolvedValueOnce(branches);

    const wts = await listWorktrees("project-1");
    const brs = await gitListBranches("s1", "project-1");

    const checkedOutBranches = new Set(wts.map((w) => w.branchName).filter(Boolean));

    // RepoOverviewPanel logic: filter local branches not in any worktree, not current, not remote
    const availableBranches = brs.filter(
      (b) => !b.is_remote && !b.is_current && !checkedOutBranches.has(b.name),
    );

    expect(availableBranches).toHaveLength(2);
    expect(availableBranches.map((b) => b.name)).toContain("feature/x");
    expect(availableBranches.map((b) => b.name)).toContain("feature/y");
    expect(availableBranches.map((b) => b.name)).not.toContain("main");
    expect(availableBranches.map((b) => b.name)).not.toContain("develop");
  });
});

// ─── Worktree lifecycle: create -> use -> remove ────────────────────

describe("Full worktree lifecycle", () => {
  it("create, verify, and remove worktree", async () => {
    // Step 1: Create worktree
    vi.mocked(invoke).mockResolvedValueOnce({
      worktreePath: "/repos/.worktrees/feature",
      branchName: "feature",
      isMainWorktree: false,
    } satisfies WorktreeCreateResult);

    const created = await createWorktree("s2", "r1", "feature", true);
    expect(created.branchName).toBe("feature");

    // Step 2: Verify it appears in list
    vi.mocked(invoke).mockResolvedValueOnce([
      makeWorktreeInfo({ sessionId: "s1", branchName: "main" }),
      makeWorktreeInfo({
        sessionId: "s2",
        branchName: "feature",
        worktreePath: "/repos/.worktrees/feature",
        isMainWorktree: false,
      }),
    ]);

    const worktrees = await listWorktrees("r1");
    expect(worktrees).toHaveLength(2);
    expect(worktrees.find((w) => w.sessionId === "s2")!.branchName).toBe("feature");

    // Step 3: Verify branch is no longer available
    vi.mocked(invoke).mockResolvedValueOnce({
      available: false,
      usedBySession: "s2",
      branchName: "feature",
    } satisfies BranchAvailability);

    const avail = await checkBranchAvailable("r1", "feature");
    expect(avail.available).toBe(false);

    // Step 4: Remove worktree
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, message: "removed", error: null });
    const removed = await removeWorktree("s2", "r1");
    expect(removed.success).toBe(true);

    // Step 5: Verify branch is now available
    vi.mocked(invoke).mockResolvedValueOnce({
      available: true,
      usedBySession: null,
      branchName: "feature",
    } satisfies BranchAvailability);

    const availAfter = await checkBranchAvailable("r1", "feature");
    expect(availAfter.available).toBe(true);
  });
});

// ─── Edge cases ─────────────────────────────────────────────────────

describe("Worktree edge cases", () => {
  it("detached HEAD worktree has null branchName", async () => {
    vi.mocked(invoke).mockResolvedValue([
      makeWorktreeInfo({ branchName: null, sessionId: "s1" }),
    ]);

    const worktrees = await listWorktrees("r1");
    expect(worktrees[0].branchName).toBeNull();
  });

  it("empty worktree list is valid", async () => {
    vi.mocked(invoke).mockResolvedValue([]);

    const worktrees = await listWorktrees("r1");
    expect(worktrees).toHaveLength(0);
  });

  it("getSessionWorktreeInfo returns null for session without worktree", async () => {
    vi.mocked(invoke).mockResolvedValue(null);

    const info = await getSessionWorktreeInfo("unknown-session", "r1");
    expect(info).toBeNull();
  });

  it("createWorktree with createBranch=false on existing branch", async () => {
    vi.mocked(invoke).mockResolvedValue({
      worktreePath: "/repos/.worktrees/existing",
      branchName: "existing-branch",
      isMainWorktree: false,
    });

    const result = await createWorktree("s2", "r1", "existing-branch", false);
    expect(invoke).toHaveBeenCalledWith("git_create_worktree", {
      sessionId: "s2",
      projectId: "r1",
      branchName: "existing-branch",
      createBranch: false,
      fromRemote: null,
      worktreeBasePath: null,
    });
    expect(result.branchName).toBe("existing-branch");
  });

  it("createWorktree rejects when branch is already checked out", async () => {
    vi.mocked(invoke).mockRejectedValue(
      new Error("fatal: 'feature/x' is already checked out at '/repos/.worktrees/feature-x'"),
    );

    await expect(createWorktree("s3", "r1", "feature/x", false)).rejects.toThrow(
      "already checked out",
    );
  });
});
