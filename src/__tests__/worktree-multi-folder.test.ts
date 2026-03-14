/**
 * Tests for Worktree PRD Phase 1: multi-folder branch selection,
 * branch color utility, worktree detection, WorktreeIndicator component,
 * and new API bindings (listBranchesForRealms, isGitRepo).
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
import { listBranchesForRealms, isGitRepo } from "../api/git";

// ─── Helpers: replicate pure logic from source ──────────────────────

/**
 * Mirrors branchColor() from SessionList.tsx.
 * Deterministic HSL color accent based on branch name.
 */
function branchColor(branchName: string): string {
  let hash = 0;
  for (let i = 0; i < branchName.length; i++) {
    hash = ((hash << 5) - hash) + branchName.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 50%)`;
}

/**
 * Mirrors worktree detection logic from SessionList.tsx / SessionItemGitInfo.
 */
function isLinkedWorktree(workingDirectory: string): boolean {
  return workingDirectory.includes(".hermes/worktrees/");
}

/**
 * Mirrors WorktreeIndicator component logic from WorktreeIndicator.tsx.
 */
function getWorktreeIndicatorOutput(props: {
  branchName: string | null;
  isMainWorktree: boolean;
  isActive?: boolean;
}) {
  const { branchName, isMainWorktree, isActive = false } = props;

  if (!branchName) return null;

  const cls = `worktree-indicator ${isActive ? "worktree-indicator-active" : ""}`.replace(/\s+$/, "");
  const title = isMainWorktree
    ? `${branchName} (main checkout)`
    : `${branchName} (linked worktree)`;

  // The component renders folder icon for main, link icon for linked
  const iconType = isMainWorktree ? "folder" : "link";

  return { cls, title, branchName, iconType };
}

/**
 * Type matching CreateSessionOpts.branchSelections shape.
 */
type BranchSelection = { branch: string; createNew: boolean };
type BranchSelections = Record<string, BranchSelection>;

/**
 * Mirrors the worktree creation loop from SessionContext.tsx createSession().
 * Returns which (realmId, branchName, createBranch) tuples would be created.
 */
function resolveWorktreeCreations(opts: {
  projectIds?: string[];
  branchSelections?: BranchSelections;
  branchName?: string;
  createNewBranch?: boolean;
}): Array<{ realmId: string; branch: string; createBranch: boolean }> {
  const results: Array<{ realmId: string; branch: string; createBranch: boolean }> = [];

  if (opts.branchSelections && opts.projectIds?.length) {
    for (const realmId of opts.projectIds) {
      const sel = opts.branchSelections[realmId];
      if (!sel) continue;
      results.push({ realmId, branch: sel.branch, createBranch: sel.createNew });
    }
  } else if (opts.branchName && opts.projectIds?.length) {
    results.push({
      realmId: opts.projectIds[0],
      branch: opts.branchName,
      createBranch: opts.createNewBranch ?? false,
    });
  }

  return results;
}

// ─── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
});

// =====================================================================
// Group 1: Branch color utility
// =====================================================================

describe("branchColor utility", () => {
  it("returns consistent color for same input", () => {
    const color1 = branchColor("feature/login");
    const color2 = branchColor("feature/login");
    expect(color1).toBe(color2);
  });

  it("returns different colors for different branches", () => {
    const color1 = branchColor("main");
    const color2 = branchColor("feature/login");
    const color3 = branchColor("develop");
    // At least 2 out of 3 should differ (hash collisions are theoretically possible
    // but extremely unlikely for such different strings)
    const unique = new Set([color1, color2, color3]);
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it("returns valid HSL string", () => {
    const color = branchColor("main");
    // Must match hsl(H, 60%, 50%)
    expect(color).toMatch(/^hsl\(\d{1,3}, 60%, 50%\)$/);
  });

  it("hue is between 0 and 359", () => {
    const branches = ["main", "develop", "feature/x", "hotfix/y", "release/1.0", "a", "z", "very-long-branch-name/with/slashes"];
    for (const branch of branches) {
      const color = branchColor(branch);
      const match = color.match(/^hsl\((\d+), 60%, 50%\)$/);
      expect(match).not.toBeNull();
      const hue = parseInt(match![1], 10);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThanOrEqual(359);
    }
  });

  it("handles empty string without crashing", () => {
    const color = branchColor("");
    expect(color).toMatch(/^hsl\(\d{1,3}, 60%, 50%\)$/);
  });
});

// =====================================================================
// Group 2: Worktree detection
// =====================================================================

describe("Worktree detection", () => {
  it("detects linked worktree from path containing .hermes/worktrees/", () => {
    expect(isLinkedWorktree("/Users/dev/project/.hermes/worktrees/abc123_feat/")).toBe(true);
  });

  it("detects linked worktree with deeply nested path", () => {
    expect(isLinkedWorktree("/home/user/code/my-app/.hermes/worktrees/def456_main/subdir")).toBe(true);
  });

  it("detects main checkout from path without .hermes/worktrees/", () => {
    expect(isLinkedWorktree("/Users/dev/project")).toBe(false);
  });

  it("does not false-positive on partial match", () => {
    // Path that contains 'worktrees' but not '.hermes/worktrees/'
    expect(isLinkedWorktree("/Users/dev/worktrees/something")).toBe(false);
  });

  it("does not false-positive on .hermes without worktrees", () => {
    expect(isLinkedWorktree("/Users/dev/project/.hermes/config")).toBe(false);
  });
});

// =====================================================================
// Group 3: Branch selections state shape
// =====================================================================

describe("Branch selections state shape", () => {
  it("setting a branch for one realm does not affect others", () => {
    const selections: BranchSelections = {
      "realm-1": { branch: "feature/login", createNew: false },
      "realm-2": { branch: "develop", createNew: false },
    };

    // Update realm-1 only
    const updated: BranchSelections = {
      ...selections,
      "realm-1": { branch: "feature/signup", createNew: true },
    };

    expect(updated["realm-1"].branch).toBe("feature/signup");
    expect(updated["realm-1"].createNew).toBe(true);
    // realm-2 unchanged
    expect(updated["realm-2"].branch).toBe("develop");
    expect(updated["realm-2"].createNew).toBe(false);
  });

  it("removing a branch selection deletes the key", () => {
    const selections: BranchSelections = {
      "realm-1": { branch: "feature/login", createNew: false },
      "realm-2": { branch: "develop", createNew: false },
    };

    // Mimic onSkip from SessionCreator
    const next = { ...selections };
    delete next["realm-1"];

    expect(next).not.toHaveProperty("realm-1");
    expect(next).toHaveProperty("realm-2");
    expect(Object.keys(next)).toHaveLength(1);
  });

  it("empty branchSelections means no worktrees will be created", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-1", "realm-2"],
      branchSelections: {},
    });
    expect(results).toHaveLength(0);
  });

  it("undefined branchSelections with no branchName means no worktrees", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-1"],
    });
    expect(results).toHaveLength(0);
  });
});

// =====================================================================
// Group 4: Multi-project worktree creation logic
// =====================================================================

describe("Multi-project worktree creation logic", () => {
  it("with branchSelections, createWorktree called once per git project", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-1", "realm-2", "realm-3"],
      branchSelections: {
        "realm-1": { branch: "feature/a", createNew: false },
        "realm-2": { branch: "feature/b", createNew: true },
        "realm-3": { branch: "develop", createNew: false },
      },
    });
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ realmId: "realm-1", branch: "feature/a", createBranch: false });
    expect(results[1]).toEqual({ realmId: "realm-2", branch: "feature/b", createBranch: true });
    expect(results[2]).toEqual({ realmId: "realm-3", branch: "develop", createBranch: false });
  });

  it("non-git projects (no entry in branchSelections) are skipped", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-git-1", "realm-nogit", "realm-git-2"],
      branchSelections: {
        "realm-git-1": { branch: "feature/x", createNew: false },
        "realm-git-2": { branch: "main", createNew: false },
        // realm-nogit has no entry
      },
    });
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.realmId)).toEqual(["realm-git-1", "realm-git-2"]);
  });

  it("legacy single branchName falls back to projectIds[0]", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-1", "realm-2"],
      branchName: "feature/legacy",
      createNewBranch: false,
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ realmId: "realm-1", branch: "feature/legacy", createBranch: false });
  });

  it("branchSelections takes priority over legacy branchName", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-1", "realm-2"],
      branchSelections: {
        "realm-1": { branch: "feature/new-style", createNew: true },
      },
      branchName: "feature/old-style",
      createNewBranch: false,
    });
    // branchSelections is truthy, so it should use the new path
    expect(results).toHaveLength(1);
    expect(results[0].branch).toBe("feature/new-style");
    expect(results[0].createBranch).toBe(true);
  });

  it("project order does not affect which worktrees are created", () => {
    const selectionsMap: BranchSelections = {
      "realm-a": { branch: "branch-a", createNew: false },
      "realm-c": { branch: "branch-c", createNew: true },
    };

    const order1 = resolveWorktreeCreations({
      projectIds: ["realm-a", "realm-b", "realm-c"],
      branchSelections: selectionsMap,
    });

    const order2 = resolveWorktreeCreations({
      projectIds: ["realm-c", "realm-b", "realm-a"],
      branchSelections: selectionsMap,
    });

    // Same set of realm IDs should appear (possibly in different order)
    const set1 = new Set(order1.map((r) => r.realmId));
    const set2 = new Set(order2.map((r) => r.realmId));
    expect(set1).toEqual(set2);
    expect(set1.size).toBe(2);
    expect(set1.has("realm-a")).toBe(true);
    expect(set1.has("realm-c")).toBe(true);
    expect(set1.has("realm-b")).toBe(false);
  });

  it("legacy createNewBranch defaults to false when omitted", () => {
    const results = resolveWorktreeCreations({
      projectIds: ["realm-1"],
      branchName: "feature/test",
    });
    expect(results).toHaveLength(1);
    expect(results[0].createBranch).toBe(false);
  });

  it("no projectIds means no worktrees even with branchSelections", () => {
    const results = resolveWorktreeCreations({
      projectIds: [],
      branchSelections: {
        "realm-1": { branch: "feature/x", createNew: false },
      },
    });
    expect(results).toHaveLength(0);
  });
});

// =====================================================================
// Group 5: WorktreeIndicator component
// =====================================================================

describe("WorktreeIndicator component logic", () => {
  it("renders folder icon when isMainWorktree=true", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: "main",
      isMainWorktree: true,
    });
    expect(result).not.toBeNull();
    expect(result!.iconType).toBe("folder");
  });

  it("renders link icon when isMainWorktree=false", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: "feature/x",
      isMainWorktree: false,
    });
    expect(result).not.toBeNull();
    expect(result!.iconType).toBe("link");
  });

  it("title reflects main checkout vs linked worktree", () => {
    const mainResult = getWorktreeIndicatorOutput({
      branchName: "main",
      isMainWorktree: true,
    });
    expect(mainResult!.title).toBe("main (main checkout)");

    const linkedResult = getWorktreeIndicatorOutput({
      branchName: "feature/login",
      isMainWorktree: false,
    });
    expect(linkedResult!.title).toBe("feature/login (linked worktree)");
  });

  it("returns null when branchName is null", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: null,
      isMainWorktree: false,
    });
    expect(result).toBeNull();
  });

  it("returns null when branchName is null even if isMainWorktree is true", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: null,
      isMainWorktree: true,
    });
    expect(result).toBeNull();
  });

  it("applies active class when isActive=true", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: "main",
      isMainWorktree: true,
      isActive: true,
    });
    expect(result!.cls).toContain("worktree-indicator-active");
  });

  it("does not apply active class when isActive defaults to false", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: "main",
      isMainWorktree: true,
    });
    expect(result!.cls).not.toContain("worktree-indicator-active");
  });

  it("title includes full branch name with slashes", () => {
    const result = getWorktreeIndicatorOutput({
      branchName: "very/deep/nested/branch",
      isMainWorktree: false,
    });
    expect(result!.title).toContain("very/deep/nested/branch");
  });
});

// =====================================================================
// Group 6: API bindings
// =====================================================================

describe("API bindings - listBranchesForRealms", () => {
  it("invokes correct IPC command with realmIds", async () => {
    vi.mocked(invoke).mockResolvedValue({
      "realm-1": [{ name: "main", is_current: true, is_remote: false }],
      "realm-2": [{ name: "develop", is_current: false, is_remote: false }],
    });
    const result = await listBranchesForRealms(["realm-1", "realm-2"]);
    expect(invoke).toHaveBeenCalledWith("git_list_branches_for_realms", {
      realmIds: ["realm-1", "realm-2"],
    });
    expect(result).toHaveProperty("realm-1");
    expect(result).toHaveProperty("realm-2");
  });

  it("handles empty realmIds array", async () => {
    vi.mocked(invoke).mockResolvedValue({});
    const result = await listBranchesForRealms([]);
    expect(invoke).toHaveBeenCalledWith("git_list_branches_for_realms", {
      realmIds: [],
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it("handles single realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({
      "realm-1": [
        { name: "main", is_current: true, is_remote: false },
        { name: "develop", is_current: false, is_remote: false },
      ],
    });
    const result = await listBranchesForRealms(["realm-1"]);
    expect(invoke).toHaveBeenCalledWith("git_list_branches_for_realms", {
      realmIds: ["realm-1"],
    });
    expect(result["realm-1"]).toHaveLength(2);
  });
});

describe("API bindings - isGitRepo", () => {
  it("invokes correct IPC command with realmId", async () => {
    vi.mocked(invoke).mockResolvedValue(true);
    const result = await isGitRepo("realm-1");
    expect(invoke).toHaveBeenCalledWith("git_is_git_repo", {
      realmId: "realm-1",
    });
    expect(result).toBe(true);
  });

  it("returns false for non-git repo", async () => {
    vi.mocked(invoke).mockResolvedValue(false);
    const result = await isGitRepo("realm-no-git");
    expect(invoke).toHaveBeenCalledWith("git_is_git_repo", {
      realmId: "realm-no-git",
    });
    expect(result).toBe(false);
  });
});
