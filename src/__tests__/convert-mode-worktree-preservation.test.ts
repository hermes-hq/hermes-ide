/**
 * Bug 4 regression tests for `convertSessionMode` (terminal ↔ agent).
 *
 * Symptom (1.2.x, only after Bug 1's close-cleanup fix lands):
 *   Converting a TERMINAL-mode session to AGENT mode tears down the
 *   subprocess via `close_session`, which now (correctly!) removes the
 *   `session_worktrees` rows AND the worktree directory from disk.
 *   The conversion then calls `spawn_agent_session` with the session's
 *   cached `working_directory`, which still points at the now-deleted
 *   worktree path.  Result: the agent boots in a missing directory and
 *   either fails to spawn (ENOENT) or boots in a stale snapshot of the
 *   path that no longer matches the user's intent.
 *
 *   The inverse path (agent → terminal) is not affected the same way:
 *   `close_agent_session` only kills the bridge subprocess and does NOT
 *   remove worktrees, so the session_worktrees row survives.  But for
 *   symmetry the helpers must handle BOTH directions correctly.
 *
 * Fix:
 *   Before closing the existing subprocess, snapshot the
 *   `session_worktrees` rows that belong to this session (excluding main
 *   worktrees and non-isolation rows).  After the close completes, call
 *   `git_create_worktree` for each preserved entry so a fresh worktree
 *   directory exists at the time `spawn_agent_session` / re-create runs.
 *
 *   The helpers `snapshotPreservableWorktrees` and `restorePreservedWorktrees`
 *   are exported from SessionContext so the contract is unit-testable
 *   without rendering the SessionProvider.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import {
  snapshotPreservableWorktrees,
  restorePreservedWorktrees,
  planConversionWorktreeRestore,
} from "../state/SessionContext";

describe("Bug 4 — planConversionWorktreeRestore decision rule", () => {
  it("plans restore-before-spawn for terminal → agent", () => {
    expect(planConversionWorktreeRestore({ currentMode: "terminal", newMode: "agent" })).toBe(
      "restore-before-spawn",
    );
  });

  it("plans no-op for agent → terminal (close_agent_session does not touch worktrees)", () => {
    // close_agent_session only kills the bridge subprocess; the
    // session_worktrees rows survive and apiCreateSession (next step)
    // can read them — no restore needed.
    expect(planConversionWorktreeRestore({ currentMode: "agent", newMode: "terminal" })).toBe(
      "no-op",
    );
  });

  it("plans no-op when currentMode === newMode (caller short-circuits anyway)", () => {
    expect(planConversionWorktreeRestore({ currentMode: "agent", newMode: "agent" })).toBe("no-op");
    expect(planConversionWorktreeRestore({ currentMode: "terminal", newMode: "terminal" })).toBe(
      "no-op",
    );
  });
});

describe("Bug 4 — snapshotPreservableWorktrees", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("returns project+branch pairs for every non-main worktree linked to the session", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { sessionId?: string; projectId?: string };
      if (cmd === "get_session_projects") {
        return [
          { id: "p1", name: "Repo A", path: "/repo-a" },
          { id: "p2", name: "Repo B", path: "/repo-b" },
        ];
      }
      if (cmd === "git_session_worktree_info") {
        if (a.projectId === "p1") {
          return {
            id: "wt-1",
            sessionId: a.sessionId,
            projectId: "p1",
            worktreePath: "/.wt/p1",
            branchName: "feature-x",
            isMainWorktree: false,
            createdAt: "2026-05-13",
          };
        }
        if (a.projectId === "p2") {
          return {
            id: "wt-2",
            sessionId: a.sessionId,
            projectId: "p2",
            worktreePath: "/.wt/p2",
            branchName: "main",
            isMainWorktree: false,
            createdAt: "2026-05-13",
          };
        }
      }
      return null;
    });

    const preserved = await snapshotPreservableWorktrees("sess-1");

    expect(preserved).toEqual([
      { projectId: "p1", branchName: "feature-x" },
      { projectId: "p2", branchName: "main" },
    ]);
  });

  it("skips main-worktree rows — they map to the project root and don't need re-creation", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { projectId?: string };
      if (cmd === "get_session_projects") return [{ id: "p1", name: "X", path: "/x" }];
      if (cmd === "git_session_worktree_info" && a.projectId === "p1") {
        return {
          id: "wt-main",
          sessionId: "sess-1",
          projectId: "p1",
          worktreePath: "/x",
          branchName: "main",
          isMainWorktree: true,
          createdAt: "2026-05-13",
        };
      }
      return null;
    });

    const preserved = await snapshotPreservableWorktrees("sess-1");
    expect(preserved).toEqual([]);
  });

  it("skips worktrees with no branch info (cannot be re-created)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { projectId?: string };
      if (cmd === "get_session_projects") return [{ id: "p1", name: "X", path: "/x" }];
      if (cmd === "git_session_worktree_info" && a.projectId === "p1") {
        return {
          id: "wt-no-branch",
          sessionId: "sess-1",
          projectId: "p1",
          worktreePath: "/.wt/p1",
          branchName: null,
          isMainWorktree: false,
          createdAt: "2026-05-13",
        };
      }
      return null;
    });

    const preserved = await snapshotPreservableWorktrees("sess-1");
    expect(preserved).toEqual([]);
  });

  it("returns [] when the session has no projects (legacy / orphan)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_projects") return [];
      return null;
    });
    expect(await snapshotPreservableWorktrees("sess-1")).toEqual([]);
  });

  it("returns [] when get_session_projects throws (non-fatal: conversion still proceeds)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_session_projects") throw new Error("DB locked");
      return null;
    });
    expect(await snapshotPreservableWorktrees("sess-1")).toEqual([]);
  });

  it("tolerates per-project worktree lookup failures and returns the survivors", async () => {
    // If we can list two projects but the lookup for one fails, we must
    // still preserve the other.  Better to restore partial isolation
    // than to lose all worktrees on a transient DB error.
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { projectId?: string };
      if (cmd === "get_session_projects") {
        return [
          { id: "p1", name: "A", path: "/a" },
          { id: "p2", name: "B", path: "/b" },
        ];
      }
      if (cmd === "git_session_worktree_info") {
        if (a.projectId === "p1") throw new Error("transient");
        if (a.projectId === "p2") {
          return {
            id: "wt-2",
            sessionId: "sess-1",
            projectId: "p2",
            worktreePath: "/.wt/p2",
            branchName: "feature-y",
            isMainWorktree: false,
            createdAt: "2026-05-13",
          };
        }
      }
      return null;
    });

    expect(await snapshotPreservableWorktrees("sess-1")).toEqual([
      { projectId: "p2", branchName: "feature-y" },
    ]);
  });
});

describe("Bug 4 — restorePreservedWorktrees", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("invokes git_create_worktree once per preserved entry, in order", async () => {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      return {
        worktreePath: "/.wt/recreated",
        branchName: "feature",
        isMainWorktree: false,
      };
    });

    await restorePreservedWorktrees("sess-1", [
      { projectId: "p1", branchName: "feature-x" },
      { projectId: "p2", branchName: "main" },
    ]);

    expect(calls).toEqual([
      {
        cmd: "git_create_worktree",
        args: { sessionId: "sess-1", projectId: "p1", branchName: "feature-x", createBranch: false, fromRemote: null, worktreeBasePath: null },
      },
      {
        cmd: "git_create_worktree",
        args: { sessionId: "sess-1", projectId: "p2", branchName: "main", createBranch: false, fromRemote: null, worktreeBasePath: null },
      },
    ]);
  });

  it("continues restoring remaining entries when an individual restore fails", async () => {
    // A failure on one project (e.g. branch in use elsewhere because of
    // a race) must not abort the rest — partial isolation > no isolation.
    let n = 0;
    const calls: string[] = [];
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = (args ?? {}) as { projectId?: string };
      calls.push(`${cmd}:${a.projectId ?? "no-args"}`);
      n++;
      if (n === 1) throw new Error("branch in use");
      return { worktreePath: "/.wt/ok", branchName: "x", isMainWorktree: false };
    });

    await restorePreservedWorktrees("sess-1", [
      { projectId: "p1", branchName: "x" },
      { projectId: "p2", branchName: "y" },
    ]);

    expect(calls).toEqual([
      "git_create_worktree:p1",
      "git_create_worktree:p2",
    ]);
  });

  it("is a no-op when the snapshot is empty (no preserved worktrees)", async () => {
    await restorePreservedWorktrees("sess-1", []);
    expect(invoke).not.toHaveBeenCalled();
  });
});
