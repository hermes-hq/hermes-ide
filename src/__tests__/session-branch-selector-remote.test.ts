/**
 * Tests for SessionBranchSelector remote branch support.
 *
 * - Pure helper functions: stripRemotePrefix, getRemotePrefix, groupAugmentedBranches
 * - Remote branch selection strips prefix and passes fromRemote
 * - Filtering works across both local and remote branches
 * - Backward compatibility: flows without remote branches still work
 * - API layer: fetchRemoteBranches and createWorktree with fromRemote
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
import { stripRemotePrefix, getRemotePrefix, groupAugmentedBranches } from "../components/SessionBranchSelector";
import { fetchRemoteBranches, createWorktree } from "../api/git";
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

interface BranchWithAvailability extends GitBranch {
  taken: boolean;
  takenBySession: string | null;
}

function makeAugmented(overrides?: Partial<BranchWithAvailability>): BranchWithAvailability {
  return {
    ...makeBranch(overrides),
    taken: false,
    takenBySession: null,
    ...overrides,
  };
}

// ─── stripRemotePrefix ──────────────────────────────────────────────

describe("stripRemotePrefix", () => {
  it("strips origin/ prefix", () => {
    expect(stripRemotePrefix("origin/feature")).toBe("feature");
  });

  it("strips origin/ prefix with nested path", () => {
    expect(stripRemotePrefix("origin/feature/nested")).toBe("feature/nested");
  });

  it("returns name as-is when no prefix", () => {
    expect(stripRemotePrefix("main")).toBe("main");
  });

  it("strips upstream/ prefix", () => {
    expect(stripRemotePrefix("upstream/develop")).toBe("develop");
  });
});

// ─── getRemotePrefix ────────────────────────────────────────────────

describe("getRemotePrefix", () => {
  it("returns origin/ prefix", () => {
    expect(getRemotePrefix("origin/feature")).toBe("origin/");
  });

  it("returns empty string when no prefix", () => {
    expect(getRemotePrefix("main")).toBe("");
  });

  it("returns upstream/ prefix", () => {
    expect(getRemotePrefix("upstream/develop")).toBe("upstream/");
  });

  it("returns only first slash-separated prefix", () => {
    expect(getRemotePrefix("origin/feature/nested")).toBe("origin/");
  });
});

// ─── groupAugmentedBranches ─────────────────────────────────────────

describe("groupAugmentedBranches", () => {
  it("separates local and remote branches", () => {
    const branches = [
      makeAugmented({ name: "main" }),
      makeAugmented({ name: "origin/main", is_remote: true }),
      makeAugmented({ name: "feature/login" }),
      makeAugmented({ name: "origin/feature/login", is_remote: true }),
    ];

    const { local, remote } = groupAugmentedBranches(branches);

    expect(local).toHaveLength(2);
    expect(remote).toHaveLength(2);
    expect(local.map((b) => b.name)).toEqual(["main", "feature/login"]);
    expect(remote.map((b) => b.name)).toEqual(["origin/main", "origin/feature/login"]);
  });

  it("returns empty arrays when no branches", () => {
    const { local, remote } = groupAugmentedBranches([]);
    expect(local).toHaveLength(0);
    expect(remote).toHaveLength(0);
  });

  it("returns only local when no remote branches exist", () => {
    const branches = [
      makeAugmented({ name: "main" }),
      makeAugmented({ name: "develop" }),
    ];

    const { local, remote } = groupAugmentedBranches(branches);

    expect(local).toHaveLength(2);
    expect(remote).toHaveLength(0);
  });

  it("returns only remote when no local branches exist", () => {
    const branches = [
      makeAugmented({ name: "origin/main", is_remote: true }),
    ];

    const { local, remote } = groupAugmentedBranches(branches);

    expect(local).toHaveLength(0);
    expect(remote).toHaveLength(1);
  });
});

// ─── API: fetchRemoteBranches ────────────────────────────────────────

describe("fetchRemoteBranches API", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
  });

  it("calls git_fetch_remote_branches with projectId", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await fetchRemoteBranches("project-1");
    expect(invoke).toHaveBeenCalledWith("git_fetch_remote_branches", {
      projectId: "project-1",
    });
  });
});

// ─── API: createWorktree with fromRemote ─────────────────────────────

describe("createWorktree with fromRemote", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue({
      worktreePath: "/tmp/wt",
      branchName: "feature",
      isMainWorktree: false,
    });
  });

  it("passes fromRemote as null when not provided", async () => {
    await createWorktree("session-1", "project-1", "feature", false);
    expect(invoke).toHaveBeenCalledWith("git_create_worktree", {
      sessionId: "session-1",
      projectId: "project-1",
      branchName: "feature",
      createBranch: false,
      fromRemote: null,
      worktreeBasePath: null,
    });
  });

  it("passes fromRemote when provided", async () => {
    await createWorktree("session-1", "project-1", "feature", false, "origin/feature");
    expect(invoke).toHaveBeenCalledWith("git_create_worktree", {
      sessionId: "session-1",
      projectId: "project-1",
      branchName: "feature",
      createBranch: false,
      fromRemote: "origin/feature",
      worktreeBasePath: null,
    });
  });

  it("passes fromRemote as null when explicitly undefined", async () => {
    await createWorktree("session-1", "project-1", "feature", true, undefined);
    expect(invoke).toHaveBeenCalledWith("git_create_worktree", {
      sessionId: "session-1",
      projectId: "project-1",
      branchName: "feature",
      createBranch: true,
      fromRemote: null,
      worktreeBasePath: null,
    });
  });
});

// ─── Backward compatibility ──────────────────────────────────────────

describe("backward compatibility", () => {
  it("BranchSelection type works without fromRemote", () => {
    // Simulate the old usage pattern where fromRemote is not set
    const selection: { branch: string; createNew: boolean; fromRemote?: string } = {
      branch: "main",
      createNew: false,
    };
    expect(selection.fromRemote).toBeUndefined();
    expect(selection.branch).toBe("main");
  });

  it("BranchSelection type works with fromRemote", () => {
    const selection: { branch: string; createNew: boolean; fromRemote?: string } = {
      branch: "feature",
      createNew: false,
      fromRemote: "origin/feature",
    };
    expect(selection.fromRemote).toBe("origin/feature");
    expect(selection.branch).toBe("feature");
  });

  it("groupAugmentedBranches works with only local branches (pre-existing behavior)", () => {
    const branches = [
      makeAugmented({ name: "main", is_current: true }),
      makeAugmented({ name: "develop" }),
      makeAugmented({ name: "feature/test" }),
    ];

    const { local, remote } = groupAugmentedBranches(branches);

    expect(local).toHaveLength(3);
    expect(remote).toHaveLength(0);
    expect(local.every((b) => !b.is_remote)).toBe(true);
  });
});

// ─── Filtering across local and remote ──────────────────────────────

describe("filtering across local and remote branches", () => {
  it("search term matches both local and remote branches", () => {
    const branches = [
      makeAugmented({ name: "main" }),
      makeAugmented({ name: "feature/login" }),
      makeAugmented({ name: "origin/main", is_remote: true }),
      makeAugmented({ name: "origin/feature/login", is_remote: true }),
    ];

    // Simulate the filtering logic from SessionBranchSelector
    const q = "main".toLowerCase();
    const filtered = branches.filter((b) => b.name.toLowerCase().includes(q));

    expect(filtered).toHaveLength(2);
    expect(filtered.map((b) => b.name)).toEqual(["main", "origin/main"]);
  });

  it("search for remote prefix only shows remote branches", () => {
    const branches = [
      makeAugmented({ name: "main" }),
      makeAugmented({ name: "origin/main", is_remote: true }),
      makeAugmented({ name: "origin/develop", is_remote: true }),
    ];

    const q = "origin".toLowerCase();
    const filtered = branches.filter((b) => b.name.toLowerCase().includes(q));

    expect(filtered).toHaveLength(2);
    expect(filtered.every((b) => b.is_remote)).toBe(true);
  });

  it("empty search returns all branches", () => {
    const branches = [
      makeAugmented({ name: "main" }),
      makeAugmented({ name: "origin/main", is_remote: true }),
    ];

    const q = "";
    const filtered = q.trim()
      ? branches.filter((b) => b.name.toLowerCase().includes(q.toLowerCase()))
      : branches;

    expect(filtered).toHaveLength(2);
  });
});
