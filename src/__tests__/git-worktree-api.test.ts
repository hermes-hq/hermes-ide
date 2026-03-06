/**
 * Tests for Git Worktree-aware API layer.
 *
 * Every exported function in src/api/git.ts must invoke the correct Tauri
 * command with the expected parameter shape (sessionId + realmId for most,
 * realmId-only for repo-scoped functions).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve({})),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { invoke } from "@tauri-apps/api/core";
import {
  gitStatus,
  gitStage,
  gitUnstage,
  gitCommit,
  gitPush,
  gitPull,
  gitDiff,
  gitOpenFile,
  gitListBranches,
  gitCreateBranch,
  gitCheckoutBranch,
  gitDeleteBranch,
  listDirectory,
  gitStashList,
  gitStashSave,
  gitStashApply,
  gitStashPop,
  gitStashDrop,
  gitStashClear,
  gitLog,
  gitCommitDetail,
  gitMergeStatus,
  gitGetConflictContent,
  gitResolveConflict,
  gitAbortMerge,
  gitContinueMerge,
  searchProject,
  createWorktree,
  removeWorktree,
  listWorktrees,
  checkBranchAvailable,
  getSessionWorktreeInfo,
} from "../api/git";

// ─── Setup ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
});

// ─── Session-scoped functions (sessionId only) ──────────────────────

describe("Git API - Session-scoped functions", () => {
  it("gitStatus passes sessionId only", async () => {
    vi.mocked(invoke).mockResolvedValue({ projects: [], timestamp: 0 });
    await gitStatus("session-1");
    expect(invoke).toHaveBeenCalledWith("git_status", {
      sessionId: "session-1",
    });
  });
});

// ─── Session+Realm scoped functions ─────────────────────────────────

describe("Git API - Worktree-aware signatures (sessionId + realmId)", () => {
  it("gitStage passes sessionId, realmId, and paths", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitStage("session-1", "realm-1", ["file.ts"]);
    expect(invoke).toHaveBeenCalledWith("git_stage", {
      sessionId: "session-1",
      realmId: "realm-1",
      paths: ["file.ts"],
    });
  });

  it("gitStage supports multiple paths", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitStage("s1", "r1", ["a.ts", "b.ts", "c.ts"]);
    expect(invoke).toHaveBeenCalledWith("git_stage", {
      sessionId: "s1",
      realmId: "r1",
      paths: ["a.ts", "b.ts", "c.ts"],
    });
  });

  it("gitUnstage passes sessionId, realmId, and paths", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitUnstage("session-1", "realm-1", ["file.ts"]);
    expect(invoke).toHaveBeenCalledWith("git_unstage", {
      sessionId: "session-1",
      realmId: "realm-1",
      paths: ["file.ts"],
    });
  });

  it("gitCommit passes sessionId, realmId, and message", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "committed", error: null });
    await gitCommit("session-1", "realm-1", "feat: add login");
    expect(invoke).toHaveBeenCalledWith("git_commit", {
      sessionId: "session-1",
      realmId: "realm-1",
      message: "feat: add login",
      authorName: null,
      authorEmail: null,
    });
  });

  it("gitCommit passes optional author fields", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "committed", error: null });
    await gitCommit("s1", "r1", "fix: typo", "Alice", "alice@example.com");
    expect(invoke).toHaveBeenCalledWith("git_commit", {
      sessionId: "s1",
      realmId: "r1",
      message: "fix: typo",
      authorName: "Alice",
      authorEmail: "alice@example.com",
    });
  });

  it("gitPush passes sessionId and realmId with null remote by default", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "pushed", error: null });
    await gitPush("session-1", "realm-1");
    expect(invoke).toHaveBeenCalledWith("git_push", {
      sessionId: "session-1",
      realmId: "realm-1",
      remote: null,
    });
  });

  it("gitPush passes explicit remote", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "pushed", error: null });
    await gitPush("s1", "r1", "upstream");
    expect(invoke).toHaveBeenCalledWith("git_push", {
      sessionId: "s1",
      realmId: "r1",
      remote: "upstream",
    });
  });

  it("gitPull passes sessionId and realmId with null remote by default", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "pulled", error: null });
    await gitPull("session-1", "realm-1");
    expect(invoke).toHaveBeenCalledWith("git_pull", {
      sessionId: "session-1",
      realmId: "realm-1",
      remote: null,
    });
  });

  it("gitPull passes explicit remote", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "pulled", error: null });
    await gitPull("s1", "r1", "origin");
    expect(invoke).toHaveBeenCalledWith("git_pull", {
      sessionId: "s1",
      realmId: "r1",
      remote: "origin",
    });
  });

  it("gitDiff passes sessionId, realmId, filePath, and staged flag", async () => {
    vi.mocked(invoke).mockResolvedValue({ path: "f.ts", diff_text: "", is_binary: false, additions: 0, deletions: 0 });
    await gitDiff("session-1", "realm-1", "src/index.ts", true);
    expect(invoke).toHaveBeenCalledWith("git_diff", {
      sessionId: "session-1",
      realmId: "realm-1",
      filePath: "src/index.ts",
      staged: true,
    });
  });

  it("gitDiff with staged=false", async () => {
    vi.mocked(invoke).mockResolvedValue({ path: "f.ts", diff_text: "", is_binary: false, additions: 0, deletions: 0 });
    await gitDiff("s1", "r1", "file.ts", false);
    expect(invoke).toHaveBeenCalledWith("git_diff", {
      sessionId: "s1",
      realmId: "r1",
      filePath: "file.ts",
      staged: false,
    });
  });

  it("gitOpenFile passes sessionId, realmId, and filePath", async () => {
    await gitOpenFile("session-1", "realm-1", "README.md");
    expect(invoke).toHaveBeenCalledWith("git_open_file", {
      sessionId: "session-1",
      realmId: "realm-1",
      filePath: "README.md",
    });
  });

  it("gitListBranches passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await gitListBranches("session-1", "realm-1");
    expect(invoke).toHaveBeenCalledWith("git_list_branches", {
      sessionId: "session-1",
      realmId: "realm-1",
    });
  });

  it("gitCreateBranch passes sessionId, realmId, name, and checkout flag", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitCreateBranch("s1", "r1", "feature/x", true);
    expect(invoke).toHaveBeenCalledWith("git_create_branch", {
      sessionId: "s1",
      realmId: "r1",
      name: "feature/x",
      checkout: true,
    });
  });

  it("gitCheckoutBranch passes sessionId, realmId, and name", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitCheckoutBranch("s1", "r1", "develop");
    expect(invoke).toHaveBeenCalledWith("git_checkout_branch", {
      sessionId: "s1",
      realmId: "r1",
      name: "develop",
    });
  });

  it("gitDeleteBranch passes sessionId, realmId, name, and force flag", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitDeleteBranch("s1", "r1", "old-branch", false);
    expect(invoke).toHaveBeenCalledWith("git_delete_branch", {
      sessionId: "s1",
      realmId: "r1",
      name: "old-branch",
      force: false,
    });
  });

  it("gitDeleteBranch with force=true", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "ok", error: null });
    await gitDeleteBranch("s1", "r1", "stale", true);
    expect(invoke).toHaveBeenCalledWith("git_delete_branch", {
      sessionId: "s1",
      realmId: "r1",
      name: "stale",
      force: true,
    });
  });

  it("listDirectory passes sessionId, realmId, and null relativePath by default", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await listDirectory("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("list_directory", {
      sessionId: "s1",
      realmId: "r1",
      relativePath: null,
    });
  });

  it("listDirectory passes explicit relativePath", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await listDirectory("s1", "r1", "src/components");
    expect(invoke).toHaveBeenCalledWith("list_directory", {
      sessionId: "s1",
      realmId: "r1",
      relativePath: "src/components",
    });
  });
});

// ─── Stash API ──────────────────────────────────────────────────────

describe("Git API - Stash functions", () => {
  it("gitStashList passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await gitStashList("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_stash_list", {
      sessionId: "s1",
      realmId: "r1",
    });
  });

  it("gitStashSave passes sessionId, realmId with defaults", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "saved", error: null });
    await gitStashSave("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_stash_save", {
      sessionId: "s1",
      realmId: "r1",
      message: null,
      includeUntracked: true,
    });
  });

  it("gitStashSave passes custom message and includeUntracked=false", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "saved", error: null });
    await gitStashSave("s1", "r1", "WIP: feature", false);
    expect(invoke).toHaveBeenCalledWith("git_stash_save", {
      sessionId: "s1",
      realmId: "r1",
      message: "WIP: feature",
      includeUntracked: false,
    });
  });

  it("gitStashApply passes sessionId, realmId, and index", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "applied", error: null });
    await gitStashApply("s1", "r1", 2);
    expect(invoke).toHaveBeenCalledWith("git_stash_apply", {
      sessionId: "s1",
      realmId: "r1",
      index: 2,
    });
  });

  it("gitStashPop passes sessionId, realmId, and index", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "popped", error: null });
    await gitStashPop("s1", "r1", 0);
    expect(invoke).toHaveBeenCalledWith("git_stash_pop", {
      sessionId: "s1",
      realmId: "r1",
      index: 0,
    });
  });

  it("gitStashDrop passes sessionId, realmId, and index", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "dropped", error: null });
    await gitStashDrop("s1", "r1", 1);
    expect(invoke).toHaveBeenCalledWith("git_stash_drop", {
      sessionId: "s1",
      realmId: "r1",
      index: 1,
    });
  });

  it("gitStashClear passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "cleared", error: null });
    await gitStashClear("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_stash_clear", {
      sessionId: "s1",
      realmId: "r1",
    });
  });
});

// ─── Log / History API ──────────────────────────────────────────────

describe("Git API - Log/History functions", () => {
  it("gitLog passes sessionId, realmId with null defaults", async () => {
    vi.mocked(invoke).mockResolvedValue({ entries: [], has_more: false, total_traversed: 0 });
    await gitLog("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_log", {
      sessionId: "s1",
      realmId: "r1",
      limit: null,
      offset: null,
    });
  });

  it("gitLog passes explicit limit and offset", async () => {
    vi.mocked(invoke).mockResolvedValue({ entries: [], has_more: false, total_traversed: 0 });
    await gitLog("s1", "r1", 50, 10);
    expect(invoke).toHaveBeenCalledWith("git_log", {
      sessionId: "s1",
      realmId: "r1",
      limit: 50,
      offset: 10,
    });
  });

  it("gitCommitDetail passes sessionId, realmId, and commitHash", async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await gitCommitDetail("s1", "r1", "abc123def");
    expect(invoke).toHaveBeenCalledWith("git_commit_detail", {
      sessionId: "s1",
      realmId: "r1",
      commitHash: "abc123def",
    });
  });
});

// ─── Merge / Conflict API ───────────────────────────────────────────

describe("Git API - Merge/Conflict functions", () => {
  it("gitMergeStatus passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({
      in_merge: false, conflicted_files: [], resolved_files: [],
      total_conflicts: 0, merge_message: null,
    });
    await gitMergeStatus("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_merge_status", {
      sessionId: "s1",
      realmId: "r1",
    });
  });

  it("gitGetConflictContent passes sessionId, realmId, and filePath", async () => {
    vi.mocked(invoke).mockResolvedValue({});
    await gitGetConflictContent("s1", "r1", "conflict.ts");
    expect(invoke).toHaveBeenCalledWith("git_get_conflict_content", {
      sessionId: "s1",
      realmId: "r1",
      filePath: "conflict.ts",
    });
  });

  it("gitResolveConflict passes sessionId, realmId, filePath, strategy, and null manualContent", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "resolved", error: null });
    await gitResolveConflict("s1", "r1", "conflict.ts", "ours");
    expect(invoke).toHaveBeenCalledWith("git_resolve_conflict", {
      sessionId: "s1",
      realmId: "r1",
      filePath: "conflict.ts",
      strategy: "ours",
      manualContent: null,
    });
  });

  it("gitResolveConflict passes manualContent for manual strategy", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "resolved", error: null });
    await gitResolveConflict("s1", "r1", "f.ts", "manual", "merged content");
    expect(invoke).toHaveBeenCalledWith("git_resolve_conflict", {
      sessionId: "s1",
      realmId: "r1",
      filePath: "f.ts",
      strategy: "manual",
      manualContent: "merged content",
    });
  });

  it("gitAbortMerge passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "aborted", error: null });
    await gitAbortMerge("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_abort_merge", {
      sessionId: "s1",
      realmId: "r1",
    });
  });

  it("gitContinueMerge passes sessionId, realmId with null defaults", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "merged", error: null });
    await gitContinueMerge("s1", "r1");
    expect(invoke).toHaveBeenCalledWith("git_continue_merge", {
      sessionId: "s1",
      realmId: "r1",
      message: null,
      authorName: null,
      authorEmail: null,
    });
  });

  it("gitContinueMerge passes optional author fields", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "merged", error: null });
    await gitContinueMerge("s1", "r1", "merge: resolve", "Bob", "bob@example.com");
    expect(invoke).toHaveBeenCalledWith("git_continue_merge", {
      sessionId: "s1",
      realmId: "r1",
      message: "merge: resolve",
      authorName: "Bob",
      authorEmail: "bob@example.com",
    });
  });
});

// ─── Search API ─────────────────────────────────────────────────────

describe("Git API - Search function", () => {
  it("searchProject passes sessionId, realmId, query, flags, and null maxResults", async () => {
    vi.mocked(invoke).mockResolvedValue({ results: [], total_matches: 0, truncated: false });
    await searchProject("s1", "r1", "TODO", false, true);
    expect(invoke).toHaveBeenCalledWith("search_project", {
      sessionId: "s1",
      realmId: "r1",
      query: "TODO",
      isRegex: false,
      caseSensitive: true,
      maxResults: null,
    });
  });

  it("searchProject passes explicit maxResults", async () => {
    vi.mocked(invoke).mockResolvedValue({ results: [], total_matches: 0, truncated: false });
    await searchProject("s1", "r1", "fix", true, false, 100);
    expect(invoke).toHaveBeenCalledWith("search_project", {
      sessionId: "s1",
      realmId: "r1",
      query: "fix",
      isRegex: true,
      caseSensitive: false,
      maxResults: 100,
    });
  });
});

// ─── Worktree API ───────────────────────────────────────────────────

describe("Git API - Worktree functions", () => {
  it("createWorktree passes sessionId, realmId, branchName, and createBranch", async () => {
    vi.mocked(invoke).mockResolvedValue({
      worktreePath: "/repos/.worktrees/feat",
      branchName: "feat",
      isMainWorktree: false,
    });
    const result = await createWorktree("session-1", "realm-1", "feat", true);
    expect(invoke).toHaveBeenCalledWith("git_create_worktree", {
      sessionId: "session-1",
      realmId: "realm-1",
      branchName: "feat",
      createBranch: true,
    });
    expect(result.worktreePath).toBe("/repos/.worktrees/feat");
    expect(result.branchName).toBe("feat");
    expect(result.isMainWorktree).toBe(false);
  });

  it("createWorktree defaults createBranch to false", async () => {
    vi.mocked(invoke).mockResolvedValue({
      worktreePath: "/path",
      branchName: "existing",
      isMainWorktree: false,
    });
    await createWorktree("s1", "r1", "existing");
    expect(invoke).toHaveBeenCalledWith("git_create_worktree", {
      sessionId: "s1",
      realmId: "r1",
      branchName: "existing",
      createBranch: false,
    });
  });

  it("removeWorktree passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true, message: "removed", error: null });
    const result = await removeWorktree("session-1", "realm-1");
    expect(invoke).toHaveBeenCalledWith("git_remove_worktree", {
      sessionId: "session-1",
      realmId: "realm-1",
    });
    expect(result.success).toBe(true);
  });

  it("listWorktrees passes only realmId", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        sessionId: "s1",
        sessionLabel: "Session 1",
        branchName: "main",
        worktreePath: "/repos/main",
        isMainWorktree: true,
      },
    ]);
    const result = await listWorktrees("realm-1");
    expect(invoke).toHaveBeenCalledWith("git_list_worktrees", {
      realmId: "realm-1",
    });
    expect(result).toHaveLength(1);
    expect(result[0].isMainWorktree).toBe(true);
  });

  it("checkBranchAvailable passes only realmId and branchName", async () => {
    vi.mocked(invoke).mockResolvedValue({
      available: false,
      usedBySession: "session-2",
      branchName: "feature/x",
    });
    const result = await checkBranchAvailable("realm-1", "feature/x");
    expect(invoke).toHaveBeenCalledWith("git_check_branch_available", {
      realmId: "realm-1",
      branchName: "feature/x",
    });
    expect(result.available).toBe(false);
    expect(result.usedBySession).toBe("session-2");
  });

  it("checkBranchAvailable returns available=true when branch is free", async () => {
    vi.mocked(invoke).mockResolvedValue({
      available: true,
      usedBySession: null,
      branchName: "new-branch",
    });
    const result = await checkBranchAvailable("r1", "new-branch");
    expect(result.available).toBe(true);
    expect(result.usedBySession).toBeNull();
  });

  it("getSessionWorktreeInfo passes sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({
      id: "wt-1",
      sessionId: "session-1",
      realmId: "realm-1",
      worktreePath: "/repos/.worktrees/feat",
      branchName: "feat",
      isMainWorktree: false,
      createdAt: "2026-01-01T00:00:00Z",
    });
    const result = await getSessionWorktreeInfo("session-1", "realm-1");
    expect(invoke).toHaveBeenCalledWith("git_session_worktree_info", {
      sessionId: "session-1",
      realmId: "realm-1",
    });
    expect(result).not.toBeNull();
    expect(result!.branchName).toBe("feat");
    expect(result!.isMainWorktree).toBe(false);
  });

  it("getSessionWorktreeInfo returns null when no worktree exists", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const result = await getSessionWorktreeInfo("s1", "r1");
    expect(result).toBeNull();
  });
});

// ─── Error handling ─────────────────────────────────────────────────

describe("Git API - Error handling", () => {
  it("gitStage rejects when invoke rejects", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("backend error"));
    await expect(gitStage("s1", "r1", ["file.ts"])).rejects.toThrow("backend error");
  });

  it("createWorktree rejects on branch conflict", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("branch already checked out"));
    await expect(createWorktree("s1", "r1", "main", false)).rejects.toThrow("branch already checked out");
  });

  it("removeWorktree rejects when worktree does not exist", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no worktree found for session"));
    await expect(removeWorktree("s1", "r1")).rejects.toThrow("no worktree found for session");
  });

  it("gitCommit rejects on empty message", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("commit message cannot be empty"));
    await expect(gitCommit("s1", "r1", "")).rejects.toThrow("commit message cannot be empty");
  });

  it("gitPush rejects on auth failure", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("authentication failed"));
    await expect(gitPush("s1", "r1")).rejects.toThrow("authentication failed");
  });

  it("gitPull rejects on merge conflict", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("merge conflict during pull"));
    await expect(gitPull("s1", "r1")).rejects.toThrow("merge conflict during pull");
  });
});

// ─── Return type shape validation ───────────────────────────────────

describe("Git API - Return type shapes", () => {
  it("gitStatus returns GitSessionStatus shape", async () => {
    vi.mocked(invoke).mockResolvedValue({ projects: [], timestamp: 1700000000 });
    const result = await gitStatus("s1");
    expect(result).toHaveProperty("projects");
    expect(result).toHaveProperty("timestamp");
    expect(Array.isArray(result.projects)).toBe(true);
  });

  it("gitDiff returns GitDiff shape", async () => {
    vi.mocked(invoke).mockResolvedValue({
      path: "index.ts",
      diff_text: "+line\n-line",
      is_binary: false,
      additions: 1,
      deletions: 1,
    });
    const result = await gitDiff("s1", "r1", "index.ts", false);
    expect(result).toHaveProperty("path");
    expect(result).toHaveProperty("diff_text");
    expect(result).toHaveProperty("is_binary");
    expect(result).toHaveProperty("additions");
    expect(result).toHaveProperty("deletions");
  });

  it("listWorktrees returns WorktreeInfo[] shape", async () => {
    vi.mocked(invoke).mockResolvedValue([
      {
        sessionId: "s1",
        sessionLabel: "Session 1",
        branchName: "main",
        worktreePath: "/path",
        isMainWorktree: true,
      },
      {
        sessionId: "s2",
        sessionLabel: "Session 2",
        branchName: "feature",
        worktreePath: "/path2",
        isMainWorktree: false,
      },
    ]);
    const result = await listWorktrees("r1");
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("sessionId");
    expect(result[0]).toHaveProperty("sessionLabel");
    expect(result[0]).toHaveProperty("branchName");
    expect(result[0]).toHaveProperty("worktreePath");
    expect(result[0]).toHaveProperty("isMainWorktree");
  });

  it("checkBranchAvailable returns BranchAvailability shape", async () => {
    vi.mocked(invoke).mockResolvedValue({
      available: true,
      usedBySession: null,
      branchName: "feature/x",
    });
    const result = await checkBranchAvailable("r1", "feature/x");
    expect(result).toHaveProperty("available");
    expect(result).toHaveProperty("usedBySession");
    expect(result).toHaveProperty("branchName");
  });
});
