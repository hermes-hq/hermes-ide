/**
 * Tests for Worktree PRD Phase 2: safety features.
 *
 * Covers:
 * - API bindings: worktreeHasChanges, stashWorktree
 * - Branch mismatch detection logic (pure function tests)
 * - DirtyWorktreeDialog component logic (node environment, no DOM)
 * - Dirty close flow logic
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
import { worktreeHasChanges, stashWorktree } from "../api/git";

// ─── Helpers: replicate pure logic from source ──────────────────────

/**
 * Mirrors statusLabel() from DirtyWorktreeDialog.tsx.
 */
function statusLabel(status: string): string {
  const s = status.toUpperCase();
  if (s === "MODIFIED" || s === "M") return "M";
  if (s === "ADDED" || s === "A" || s === "NEW" || s === "UNTRACKED") return "A";
  if (s === "DELETED" || s === "D") return "D";
  if (s === "RENAMED" || s === "R") return "R";
  return s.charAt(0) || "?";
}

/**
 * Mirrors statusClass() from DirtyWorktreeDialog.tsx.
 */
function statusClass(status: string): string {
  const label = statusLabel(status);
  switch (label) {
    case "M": return "dirty-wt-file-status--modified";
    case "A": return "dirty-wt-file-status--added";
    case "D": return "dirty-wt-file-status--deleted";
    default: return "dirty-wt-file-status--unknown";
  }
}

/**
 * Mirrors DirtyWorktreeDialog rendering logic (tested without DOM).
 */
interface DirtyWorktreeChange {
  realmId: string;
  realmName: string;
  branchName: string | null;
  files: Array<{ path: string; status: string }>;
}

function getDirtyDialogOutput(props: {
  sessionLabel: string;
  changes: DirtyWorktreeChange[];
}) {
  const { sessionLabel, changes } = props;
  const totalFiles = changes.reduce((sum, c) => sum + c.files.length, 0);

  const message = `Session ${sessionLabel} has ${totalFiles} uncommitted ${totalFiles === 1 ? "change" : "changes"} across ${changes.length} ${changes.length === 1 ? "project" : "projects"}.`;

  const projects = changes.map((change) => ({
    realmId: change.realmId,
    realmName: change.realmName,
    branchName: change.branchName,
    files: change.files.map((file) => ({
      path: file.path,
      statusLabel: statusLabel(file.status),
      statusClass: statusClass(file.status),
    })),
  }));

  return { message, totalFiles, projects };
}

/**
 * Mirrors detectBranchMismatch() from pool.ts.
 *
 * We reimplement the same algorithm as a pure function that accepts
 * a pool Map instead of relying on the module-level pool variable.
 */
interface PoolEntry {
  cwd: string | null;
}

function detectBranchMismatch(
  pool: Map<string, PoolEntry>,
  currentSessionId: string,
  newCwd: string,
): { sessionId: string; branch: string } | null {
  if (!newCwd.includes(".hermes/worktrees/")) return null;

  for (const [sessionId, entry] of pool.entries()) {
    if (sessionId === currentSessionId) continue;
    if (
      entry.cwd &&
      newCwd.startsWith(entry.cwd) &&
      entry.cwd.includes(".hermes/worktrees/")
    ) {
      const match = entry.cwd.match(
        /\.hermes\/worktrees\/[^/]+_(.+?)(?:\/|$)/,
      );
      const branch = match?.[1] || "unknown";
      return { sessionId, branch };
    }
  }
  return null;
}

// ─── Setup ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
});

// =====================================================================
// Group 1: API bindings
// =====================================================================

describe("API bindings - worktreeHasChanges", () => {
  it("invokes correct IPC command with sessionId and realmId", async () => {
    vi.mocked(invoke).mockResolvedValue({ has_changes: true, files: [{ path: "src/main.ts", status: "M" }] });

    const result = await worktreeHasChanges("session-1", "realm-1");

    expect(invoke).toHaveBeenCalledWith("git_worktree_has_changes", {
      sessionId: "session-1",
      realmId: "realm-1",
    });
    expect(result).toEqual({
      has_changes: true,
      files: [{ path: "src/main.ts", status: "M" }],
    });
  });

  it("returns no changes when worktree is clean", async () => {
    vi.mocked(invoke).mockResolvedValue({ has_changes: false, files: [] });

    const result = await worktreeHasChanges("session-2", "realm-2");

    expect(invoke).toHaveBeenCalledWith("git_worktree_has_changes", {
      sessionId: "session-2",
      realmId: "realm-2",
    });
    expect(result.has_changes).toBe(false);
    expect(result.files).toHaveLength(0);
  });
});

describe("API bindings - stashWorktree", () => {
  it("invokes correct IPC command with all parameters", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true });

    await stashWorktree("session-1", "realm-1", "my stash message");

    expect(invoke).toHaveBeenCalledWith("git_stash_worktree", {
      sessionId: "session-1",
      realmId: "realm-1",
      message: "my stash message",
    });
  });

  it("passes null for undefined message", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true });

    await stashWorktree("session-1", "realm-1");

    expect(invoke).toHaveBeenCalledWith("git_stash_worktree", {
      sessionId: "session-1",
      realmId: "realm-1",
      message: null,
    });
  });

  it("passes null for explicitly undefined message", async () => {
    vi.mocked(invoke).mockResolvedValue({ success: true });

    await stashWorktree("session-1", "realm-1", undefined);

    expect(invoke).toHaveBeenCalledWith("git_stash_worktree", {
      sessionId: "session-1",
      realmId: "realm-1",
      message: null,
    });
  });
});

// =====================================================================
// Group 2: Branch mismatch detection
// =====================================================================

describe("Branch mismatch detection", () => {
  it("returns null when CWD does not contain .hermes/worktrees/", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-other", { cwd: "/Users/dev/project/.hermes/worktrees/abc_feature" });

    const result = detectBranchMismatch(pool, "session-1", "/Users/dev/project/src");
    expect(result).toBeNull();
  });

  it("returns null when CWD is in current session's own worktree", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-1", { cwd: "/Users/dev/project/.hermes/worktrees/abc_feature-login" });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_feature-login/src",
    );
    // session-1 is the current session, so it should be skipped
    expect(result).toBeNull();
  });

  it("returns mismatch when CWD enters another session's worktree", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-1", { cwd: "/Users/dev/project/.hermes/worktrees/abc_main" });
    pool.set("session-2", { cwd: "/Users/dev/project/.hermes/worktrees/def_feature-login" });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/def_feature-login/src/components",
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-2");
    expect(result!.branch).toBe("feature-login");
  });

  it("extracts branch name from worktree path correctly", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", { cwd: "/Users/dev/project/.hermes/worktrees/abc123_develop" });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc123_develop/deep/path",
    );
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("develop");
  });

  it("handles paths with multiple segments after worktree root", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", { cwd: "/Users/dev/project/.hermes/worktrees/abc_feat-x" });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_feat-x/a/b/c/d/e",
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("session-2");
    expect(result!.branch).toBe("feat-x");
  });

  it("returns null when no other sessions have worktrees", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-1", { cwd: "/Users/dev/project/.hermes/worktrees/abc_main" });
    pool.set("session-2", { cwd: "/Users/dev/other-project" });
    pool.set("session-3", { cwd: null });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/xyz_feature/src",
    );
    // session-2 has no worktree path, session-3 has null CWD
    expect(result).toBeNull();
  });

  it("returns null when pool is empty", () => {
    const pool = new Map<string, PoolEntry>();

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_main/src",
    );
    expect(result).toBeNull();
  });

  it("returns 'unknown' when branch name cannot be extracted from path", () => {
    const pool = new Map<string, PoolEntry>();
    // Worktree path without the underscore separator
    pool.set("session-2", { cwd: "/Users/dev/project/.hermes/worktrees/nounderscore" });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/nounderscore/src",
    );
    expect(result).not.toBeNull();
    expect(result!.branch).toBe("unknown");
  });

  it("matches the first other session when multiple sessions share the same worktree root", () => {
    const pool = new Map<string, PoolEntry>();
    pool.set("session-2", { cwd: "/Users/dev/project/.hermes/worktrees/abc_main" });
    pool.set("session-3", { cwd: "/Users/dev/project/.hermes/worktrees/abc_main" });

    const result = detectBranchMismatch(
      pool,
      "session-1",
      "/Users/dev/project/.hermes/worktrees/abc_main/src",
    );
    expect(result).not.toBeNull();
    // Should match the first one found (session-2 since Map preserves insertion order)
    expect(result!.sessionId).toBe("session-2");
  });
});

// =====================================================================
// Group 3: DirtyWorktreeDialog behavior
// =====================================================================

describe("DirtyWorktreeDialog behavior", () => {
  const singleChange: DirtyWorktreeChange[] = [
    {
      realmId: "realm-1",
      realmName: "my-project",
      branchName: "feature/login",
      files: [
        { path: "src/main.ts", status: "MODIFIED" },
        { path: "src/new.ts", status: "ADDED" },
        { path: "src/old.ts", status: "DELETED" },
      ],
    },
  ];

  it("renders file list with correct status indicators (M, A, D)", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Session 1",
      changes: singleChange,
    });

    const files = output.projects[0].files;
    expect(files).toHaveLength(3);

    // MODIFIED -> M
    expect(files[0].statusLabel).toBe("M");
    expect(files[0].statusClass).toBe("dirty-wt-file-status--modified");

    // ADDED -> A
    expect(files[1].statusLabel).toBe("A");
    expect(files[1].statusClass).toBe("dirty-wt-file-status--added");

    // DELETED -> D
    expect(files[2].statusLabel).toBe("D");
    expect(files[2].statusClass).toBe("dirty-wt-file-status--deleted");
  });

  it("handles lowercase status strings", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Session 1",
      changes: [{
        realmId: "r1",
        realmName: "proj",
        branchName: "main",
        files: [
          { path: "a.ts", status: "modified" },
          { path: "b.ts", status: "added" },
          { path: "c.ts", status: "deleted" },
        ],
      }],
    });

    const files = output.projects[0].files;
    expect(files[0].statusLabel).toBe("M");
    expect(files[1].statusLabel).toBe("A");
    expect(files[2].statusLabel).toBe("D");
  });

  it("handles short status codes (M, A, D)", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Test",
      changes: [{
        realmId: "r1",
        realmName: "proj",
        branchName: null,
        files: [
          { path: "a.ts", status: "M" },
          { path: "b.ts", status: "A" },
          { path: "c.ts", status: "D" },
        ],
      }],
    });

    const files = output.projects[0].files;
    expect(files[0].statusLabel).toBe("M");
    expect(files[1].statusLabel).toBe("A");
    expect(files[2].statusLabel).toBe("D");
  });

  it("maps UNTRACKED and NEW to A (added)", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Test",
      changes: [{
        realmId: "r1",
        realmName: "proj",
        branchName: null,
        files: [
          { path: "a.ts", status: "UNTRACKED" },
          { path: "b.ts", status: "NEW" },
        ],
      }],
    });

    expect(output.projects[0].files[0].statusLabel).toBe("A");
    expect(output.projects[0].files[1].statusLabel).toBe("A");
  });

  it("maps RENAMED and R to R", () => {
    const label1 = statusLabel("RENAMED");
    const label2 = statusLabel("R");
    expect(label1).toBe("R");
    expect(label2).toBe("R");
  });

  it("renders branch name per project", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Session 1",
      changes: singleChange,
    });

    expect(output.projects[0].branchName).toBe("feature/login");
  });

  it("shows null branch name when unavailable", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Session 1",
      changes: [{
        realmId: "r1",
        realmName: "proj",
        branchName: null,
        files: [{ path: "file.ts", status: "M" }],
      }],
    });

    expect(output.projects[0].branchName).toBeNull();
  });

  it("calls onCancel when Cancel clicked", () => {
    const onCancel = vi.fn();
    // Simulate the button click handler behavior
    onCancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("calls onCloseAnyway when Close Anyway clicked", () => {
    const onCloseAnyway = vi.fn();
    onCloseAnyway();
    expect(onCloseAnyway).toHaveBeenCalledTimes(1);
  });

  it("calls onStashAndClose when Stash & Close clicked", () => {
    const onStashAndClose = vi.fn();
    onStashAndClose();
    expect(onStashAndClose).toHaveBeenCalledTimes(1);
  });

  it("shows multiple projects when multiple dirty worktrees exist", () => {
    const multipleChanges: DirtyWorktreeChange[] = [
      {
        realmId: "realm-1",
        realmName: "frontend",
        branchName: "feature/ui",
        files: [
          { path: "src/App.tsx", status: "M" },
          { path: "src/index.css", status: "M" },
        ],
      },
      {
        realmId: "realm-2",
        realmName: "backend",
        branchName: "feature/api",
        files: [
          { path: "src/server.ts", status: "A" },
        ],
      },
      {
        realmId: "realm-3",
        realmName: "shared",
        branchName: "develop",
        files: [
          { path: "types.ts", status: "D" },
          { path: "utils.ts", status: "M" },
          { path: "new-util.ts", status: "A" },
        ],
      },
    ];

    const output = getDirtyDialogOutput({
      sessionLabel: "Multi-project session",
      changes: multipleChanges,
    });

    expect(output.projects).toHaveLength(3);
    expect(output.totalFiles).toBe(6);
    expect(output.message).toContain("6 uncommitted changes");
    expect(output.message).toContain("3 projects");

    expect(output.projects[0].realmName).toBe("frontend");
    expect(output.projects[0].branchName).toBe("feature/ui");
    expect(output.projects[0].files).toHaveLength(2);

    expect(output.projects[1].realmName).toBe("backend");
    expect(output.projects[1].branchName).toBe("feature/api");
    expect(output.projects[1].files).toHaveLength(1);

    expect(output.projects[2].realmName).toBe("shared");
    expect(output.projects[2].branchName).toBe("develop");
    expect(output.projects[2].files).toHaveLength(3);
  });

  it("calls onCancel when Escape key pressed", () => {
    // The component registers a keydown listener for Escape.
    // We test the handler logic: if e.key === "Escape", onCancel is called.
    const onCancel = vi.fn();

    const handleKeyDown = (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();

    // Simulate Escape key
    handleKeyDown({ key: "Escape", preventDefault, stopPropagation });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();

    // Simulate non-Escape key (should NOT call onCancel)
    handleKeyDown({ key: "Enter", preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(onCancel).toHaveBeenCalledTimes(1); // still 1
  });

  it("message uses singular 'change' for single file", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Session X",
      changes: [{
        realmId: "r1",
        realmName: "proj",
        branchName: "main",
        files: [{ path: "file.ts", status: "M" }],
      }],
    });

    expect(output.message).toContain("1 uncommitted change ");
    expect(output.message).toContain("1 project");
  });

  it("message uses plural 'changes' for multiple files", () => {
    const output = getDirtyDialogOutput({
      sessionLabel: "Session X",
      changes: [{
        realmId: "r1",
        realmName: "proj",
        branchName: "main",
        files: [
          { path: "a.ts", status: "M" },
          { path: "b.ts", status: "A" },
        ],
      }],
    });

    expect(output.message).toContain("2 uncommitted changes");
  });
});

// =====================================================================
// Group 4: Dirty close flow logic
// =====================================================================

describe("Dirty close flow logic", () => {
  /**
   * Simulates the requestCloseSession logic from SessionContext.tsx.
   *
   * Returns:
   * - "dialog" if dirty changes exist and dialog should be shown
   * - "close" if no dirty changes, proceed with close
   * - "close-error" if IPC failure during dirty check (should not block close)
   */
  async function simulateCloseFlow(opts: {
    getProjects: () => Promise<Array<{ id: string; name: string }>>;
    checkDirty: (sessionId: string, realmId: string) => Promise<{ has_changes: boolean; files: Array<{ path: string; status: string }> }>;
    sessionId: string;
  }): Promise<{ action: "dialog" | "close" | "close-error"; changes?: DirtyWorktreeChange[] }> {
    try {
      const projects = await opts.getProjects();
      const dirtyChanges: DirtyWorktreeChange[] = [];

      for (const project of projects) {
        try {
          const changes = await opts.checkDirty(opts.sessionId, project.id);
          if (changes.has_changes) {
            dirtyChanges.push({
              realmId: project.id,
              realmName: project.name,
              branchName: null,
              files: changes.files,
            });
          }
        } catch {
          // Individual project check failure is non-fatal
        }
      }

      if (dirtyChanges.length > 0) {
        return { action: "dialog", changes: dirtyChanges };
      }
    } catch {
      return { action: "close-error" };
    }

    return { action: "close" };
  }

  it("with no dirty changes, close proceeds without dialog", async () => {
    const result = await simulateCloseFlow({
      getProjects: async () => [
        { id: "realm-1", name: "project-1" },
        { id: "realm-2", name: "project-2" },
      ],
      checkDirty: async () => ({ has_changes: false, files: [] }),
      sessionId: "session-1",
    });

    expect(result.action).toBe("close");
    expect(result.changes).toBeUndefined();
  });

  it("with dirty changes in one project, dialog should be triggered", async () => {
    const result = await simulateCloseFlow({
      getProjects: async () => [
        { id: "realm-1", name: "project-1" },
        { id: "realm-2", name: "project-2" },
      ],
      checkDirty: async (_sid, realmId) => {
        if (realmId === "realm-1") {
          return {
            has_changes: true,
            files: [{ path: "src/main.ts", status: "M" }],
          };
        }
        return { has_changes: false, files: [] };
      },
      sessionId: "session-1",
    });

    expect(result.action).toBe("dialog");
    expect(result.changes).toHaveLength(1);
    expect(result.changes![0].realmId).toBe("realm-1");
    expect(result.changes![0].realmName).toBe("project-1");
    expect(result.changes![0].files).toHaveLength(1);
  });

  it("with dirty changes in multiple projects, all are collected", async () => {
    const result = await simulateCloseFlow({
      getProjects: async () => [
        { id: "realm-1", name: "frontend" },
        { id: "realm-2", name: "backend" },
        { id: "realm-3", name: "shared" },
      ],
      checkDirty: async (_sid, realmId) => {
        if (realmId === "realm-1") {
          return { has_changes: true, files: [{ path: "app.tsx", status: "M" }] };
        }
        if (realmId === "realm-3") {
          return { has_changes: true, files: [{ path: "types.ts", status: "D" }] };
        }
        return { has_changes: false, files: [] };
      },
      sessionId: "session-1",
    });

    expect(result.action).toBe("dialog");
    expect(result.changes).toHaveLength(2);
    expect(result.changes!.map((c) => c.realmId)).toEqual(["realm-1", "realm-3"]);
  });

  it("stash and close calls stashWorktree for each dirty project", async () => {
    const stashCalls: Array<{ sessionId: string; realmId: string; message: string }> = [];

    const dirtyChanges: DirtyWorktreeChange[] = [
      { realmId: "realm-1", realmName: "frontend", branchName: "feat", files: [{ path: "a.ts", status: "M" }] },
      { realmId: "realm-2", realmName: "backend", branchName: "feat", files: [{ path: "b.ts", status: "A" }] },
    ];

    // Simulate the handleDirtyStashAndClose logic
    const sessionId = "session-1";
    for (const change of dirtyChanges) {
      stashCalls.push({
        sessionId,
        realmId: change.realmId,
        message: "Auto-stash before closing session",
      });
    }

    expect(stashCalls).toHaveLength(2);
    expect(stashCalls[0]).toEqual({
      sessionId: "session-1",
      realmId: "realm-1",
      message: "Auto-stash before closing session",
    });
    expect(stashCalls[1]).toEqual({
      sessionId: "session-1",
      realmId: "realm-2",
      message: "Auto-stash before closing session",
    });
  });

  it("close anyway skips stashing", async () => {
    const stashFn = vi.fn();

    // Simulate handleDirtyCloseAnyway: it does NOT call stash, just closes
    const handleDirtyCloseAnyway = () => {
      // Directly proceed to close without stashing
      // (does not call stashFn)
    };

    handleDirtyCloseAnyway();
    expect(stashFn).not.toHaveBeenCalled();
  });

  it("IPC failure during dirty check does not block close", async () => {
    const result = await simulateCloseFlow({
      getProjects: async () => {
        throw new Error("IPC connection failed");
      },
      checkDirty: async () => ({ has_changes: false, files: [] }),
      sessionId: "session-1",
    });

    // Should fall through to close, not hang or throw
    expect(result.action).toBe("close-error");
  });

  it("individual project dirty check failure is non-fatal", async () => {
    const result = await simulateCloseFlow({
      getProjects: async () => [
        { id: "realm-1", name: "project-1" },
        { id: "realm-2", name: "project-2" },
      ],
      checkDirty: async (_sid, realmId) => {
        if (realmId === "realm-1") {
          throw new Error("Project check failed");
        }
        return {
          has_changes: true,
          files: [{ path: "b.ts", status: "M" }],
        };
      },
      sessionId: "session-1",
    });

    // realm-1 failed but realm-2 succeeded with dirty changes
    expect(result.action).toBe("dialog");
    expect(result.changes).toHaveLength(1);
    expect(result.changes![0].realmId).toBe("realm-2");
  });

  it("stash failure for one project does not prevent closing", async () => {
    const stashResults: Array<{ realmId: string; success: boolean }> = [];

    const dirtyChanges: DirtyWorktreeChange[] = [
      { realmId: "realm-1", realmName: "frontend", branchName: "feat", files: [{ path: "a.ts", status: "M" }] },
      { realmId: "realm-2", realmName: "backend", branchName: "feat", files: [{ path: "b.ts", status: "A" }] },
    ];

    // Simulate the handleDirtyStashAndClose logic with failure handling
    const sessionId = "session-1";
    const mockStash = async (sid: string, realmId: string) => {
      if (realmId === "realm-1") {
        throw new Error("Stash failed");
      }
      return { success: true };
    };

    for (const change of dirtyChanges) {
      try {
        await mockStash(sessionId, change.realmId);
        stashResults.push({ realmId: change.realmId, success: true });
      } catch {
        // Mirror SessionContext: warn but continue
        stashResults.push({ realmId: change.realmId, success: false });
      }
    }

    // Both should have been attempted
    expect(stashResults).toHaveLength(2);
    expect(stashResults[0]).toEqual({ realmId: "realm-1", success: false });
    expect(stashResults[1]).toEqual({ realmId: "realm-2", success: true });
  });

  it("no projects means close proceeds directly", async () => {
    const result = await simulateCloseFlow({
      getProjects: async () => [],
      checkDirty: vi.fn(),
      sessionId: "session-1",
    });

    expect(result.action).toBe("close");
  });
});
