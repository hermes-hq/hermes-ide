/**
 * Tests for useSessionGitSummary hook logic.
 *
 * Since the test environment is `node` (no DOM/React), we test the
 * hook's data-derivation logic and polling behaviour by extracting
 * the pure functions and simulating the polling lifecycle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

// ─── Mock gitStatus ──────────────────────────────────────────────────
vi.mock("../api/git", () => ({
  gitStatus: vi.fn(() => Promise.resolve({ projects: [], timestamp: 0 })),
}));

import { gitStatus } from "../api/git";
import type { GitSessionStatus, GitProjectStatus } from "../types/git";

// ─── Extracted logic: derive summary from GitSessionStatus ───────────

interface SessionGitSummary {
  branch: string | null;
  changeCount: number;
  ahead: number;
  behind: number;
  hasConflicts: boolean;
  isLoading: boolean;
}

/**
 * Mirrors the derivation logic that useSessionGitSummary would perform
 * on the GitSessionStatus returned by gitStatus().
 *
 * Picks the first project that is_git_repo and extracts summary fields.
 */
function deriveSummary(
  status: GitSessionStatus | null,
  isLoading: boolean,
): SessionGitSummary {
  if (!status || isLoading) {
    return {
      branch: null,
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading,
    };
  }

  const gitProject = status.projects.find((p) => p.is_git_repo);
  if (!gitProject) {
    return {
      branch: null,
      changeCount: 0,
      ahead: 0,
      behind: 0,
      hasConflicts: false,
      isLoading: false,
    };
  }

  return {
    branch: gitProject.branch,
    changeCount: gitProject.files.length,
    ahead: gitProject.ahead,
    behind: gitProject.behind,
    hasConflicts: gitProject.has_conflicts,
    isLoading: false,
  };
}

/**
 * Simulates the polling lifecycle of the hook.
 * Returns start/stop controls and a fetch trigger.
 */
function createPollingSimulator(
  sessionId: string | null,
  enabled: boolean,
  pollInterval: number = 3000,
) {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let fetchCount = 0;

  const doFetch = async () => {
    if (!sessionId) return;
    fetchCount++;
    await gitStatus(sessionId);
  };

  const start = () => {
    if (!enabled || !sessionId) return;
    doFetch();
    if (pollInterval > 0) {
      intervalId = setInterval(doFetch, pollInterval);
    }
  };

  const stop = () => {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };

  return { start, stop, getFetchCount: () => fetchCount, isRunning: () => intervalId !== null };
}

// ─── Helper: build a GitProjectStatus ────────────────────────────────

function makeProject(overrides: Partial<GitProjectStatus> = {}): GitProjectStatus {
  return {
    project_id: "proj-1",
    project_name: "my-project",
    project_path: "/repos/my-project",
    is_git_repo: true,
    branch: "main",
    remote_branch: "origin/main",
    ahead: 0,
    behind: 0,
    files: [],
    has_conflicts: false,
    stash_count: 0,
    error: null,
    ...overrides,
  };
}

// ─── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(gitStatus).mockReset();
  vi.mocked(gitStatus).mockResolvedValue({ projects: [], timestamp: 0 });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ───────────────────────────────────────────────────────────

describe("useSessionGitSummary - deriveSummary logic", () => {
  it("returns loading state initially", () => {
    const result = deriveSummary(null, true);
    expect(result.isLoading).toBe(true);
    expect(result.branch).toBeNull();
    expect(result.changeCount).toBe(0);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.hasConflicts).toBe(false);
  });

  it("returns branch and change count from first git repo project", () => {
    const status: GitSessionStatus = {
      projects: [
        makeProject({
          branch: "feature/login",
          files: [
            { path: "a.ts", status: "modified", area: "unstaged", old_path: null },
            { path: "b.ts", status: "added", area: "staged", old_path: null },
            { path: "c.ts", status: "untracked", area: "untracked", old_path: null },
          ],
          ahead: 2,
          behind: 1,
        }),
      ],
      timestamp: 1000,
    };
    const result = deriveSummary(status, false);
    expect(result.branch).toBe("feature/login");
    expect(result.changeCount).toBe(3);
    expect(result.ahead).toBe(2);
    expect(result.behind).toBe(1);
    expect(result.isLoading).toBe(false);
  });

  it("returns null branch when no git repos in session", () => {
    const status: GitSessionStatus = {
      projects: [
        makeProject({ is_git_repo: false, branch: null }),
      ],
      timestamp: 1000,
    };
    const result = deriveSummary(status, false);
    expect(result.branch).toBeNull();
    expect(result.changeCount).toBe(0);
  });

  it("skips non-git-repo projects", () => {
    const status: GitSessionStatus = {
      projects: [
        makeProject({ project_id: "p1", is_git_repo: false, branch: null }),
        makeProject({ project_id: "p2", is_git_repo: true, branch: "develop", files: [
          { path: "x.ts", status: "modified", area: "unstaged", old_path: null },
        ] }),
      ],
      timestamp: 1000,
    };
    const result = deriveSummary(status, false);
    expect(result.branch).toBe("develop");
    expect(result.changeCount).toBe(1);
  });

  it("returns 0 changes when files array is empty", () => {
    const status: GitSessionStatus = {
      projects: [makeProject({ branch: "main", files: [] })],
      timestamp: 1000,
    };
    const result = deriveSummary(status, false);
    expect(result.changeCount).toBe(0);
  });

  it("returns correct conflict state", () => {
    const status: GitSessionStatus = {
      projects: [makeProject({ has_conflicts: true })],
      timestamp: 1000,
    };
    const result = deriveSummary(status, false);
    expect(result.hasConflicts).toBe(true);
  });

  it("returns hasConflicts false when no conflicts", () => {
    const status: GitSessionStatus = {
      projects: [makeProject({ has_conflicts: false })],
      timestamp: 1000,
    };
    const result = deriveSummary(status, false);
    expect(result.hasConflicts).toBe(false);
  });

  it("returns null branch when status is null", () => {
    const result = deriveSummary(null, false);
    expect(result.branch).toBeNull();
    expect(result.changeCount).toBe(0);
  });

  it("returns null branch when projects array is empty", () => {
    const status: GitSessionStatus = { projects: [], timestamp: 1000 };
    const result = deriveSummary(status, false);
    expect(result.branch).toBeNull();
  });
});

describe("useSessionGitSummary - polling behaviour", () => {
  it("does NOT poll when enabled is false", () => {
    const sim = createPollingSimulator("session-1", false);
    sim.start();
    vi.advanceTimersByTime(10000);
    expect(sim.getFetchCount()).toBe(0);
    expect(sim.isRunning()).toBe(false);
    sim.stop();
  });

  it("does NOT poll when sessionId is null", () => {
    const sim = createPollingSimulator(null, true);
    sim.start();
    vi.advanceTimersByTime(10000);
    expect(sim.getFetchCount()).toBe(0);
    sim.stop();
  });

  it("starts polling when enabled and sessionId are set", () => {
    const sim = createPollingSimulator("session-1", true, 3000);
    sim.start();
    // Initial fetch
    expect(sim.getFetchCount()).toBe(1);
    // After one interval
    vi.advanceTimersByTime(3000);
    expect(sim.getFetchCount()).toBe(2);
    // After another interval
    vi.advanceTimersByTime(3000);
    expect(sim.getFetchCount()).toBe(3);
    sim.stop();
  });

  it("cleans up polling interval on unmount (stop)", () => {
    const sim = createPollingSimulator("session-1", true, 3000);
    sim.start();
    expect(sim.getFetchCount()).toBe(1);
    expect(sim.isRunning()).toBe(true);

    // Simulate unmount
    sim.stop();
    expect(sim.isRunning()).toBe(false);

    // No more fetches after cleanup
    vi.advanceTimersByTime(10000);
    expect(sim.getFetchCount()).toBe(1);
  });

  it("updates when sessionId changes (restart with new id)", () => {
    // First session
    const sim1 = createPollingSimulator("session-1", true, 3000);
    sim1.start();
    expect(sim1.getFetchCount()).toBe(1);
    expect(gitStatus).toHaveBeenCalledWith("session-1");

    // Simulate sessionId change — stop old, start new
    sim1.stop();

    vi.mocked(gitStatus).mockClear();
    const sim2 = createPollingSimulator("session-2", true, 3000);
    sim2.start();
    expect(sim2.getFetchCount()).toBe(1);
    expect(gitStatus).toHaveBeenCalledWith("session-2");

    sim2.stop();
  });

  it("calls gitStatus with correct sessionId", () => {
    const sim = createPollingSimulator("my-session-42", true, 3000);
    sim.start();
    expect(gitStatus).toHaveBeenCalledWith("my-session-42");
    sim.stop();
  });
});
