/**
 * F09 — honest isolation: the pure decisions behind "two tasks never share
 * a checkout by accident" (src/state/isolation.ts).
 */
import { describe, it, expect, vi } from "vitest";
import {
  BRANCH_IN_USE_PREFIX,
  parseBranchInUseError,
  slugify,
  randomTaskSlug,
  defaultTaskBranch,
  pickRestoreId,
  createSessionWorktrees,
  closeCommitMessage,
  shouldAskAboutChangesOnClose,
  describeBranchHolder,
  workingDirectoryRecoveryMessage,
  type WorktreeDeps,
  type BranchConflictChoice,
} from "../state/isolation";
import type { SessionWorktree, WorktreeCreateResult } from "../types/git";

const inUse = (branch: string, path: string, extra: Record<string, unknown> = {}) =>
  `${BRANCH_IN_USE_PREFIX}${JSON.stringify({ branch, path, ...extra })}`;

describe("parseBranchInUseError", () => {
  it("reads the backend's BRANCH_IN_USE error", () => {
    expect(
      parseBranchInUseError(inUse("hermes/a", "/tmp/hermes-test/wt", { sessionId: "s1", projectFolder: false })),
    ).toEqual({ branch: "hermes/a", path: "/tmp/hermes-test/wt", sessionId: "s1", projectFolder: false });
  });

  it("accepts Error objects and missing optional fields", () => {
    expect(parseBranchInUseError(new Error(inUse("main", "/tmp/hermes-test/repo", { projectFolder: true })))).toEqual({
      branch: "main",
      path: "/tmp/hermes-test/repo",
      sessionId: null,
      projectFolder: true,
    });
  });

  it("returns null for every other error", () => {
    expect(parseBranchInUseError("git worktree add failed: fatal")).toBeNull();
    expect(parseBranchInUseError(`${BRANCH_IN_USE_PREFIX}not json`)).toBeNull();
    expect(parseBranchInUseError(`${BRANCH_IN_USE_PREFIX}{"branch":1}`)).toBeNull();
    expect(parseBranchInUseError(undefined)).toBeNull();
  });
});

describe("default task branch", () => {
  it("slugifies to branch-safe text", () => {
    expect(slugify("  Fix Login: Ünïcode & spaces!  ")).toBe("fix-login-unicode-spaces");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(60)).length).toBe(40);
  });

  it("random task slugs look like task-xxxx", () => {
    expect(randomTaskSlug(() => 0)).toBe("task-aaaa");
    expect(randomTaskSlug()).toMatch(/^task-[a-z2-9]{4}$/);
  });

  it("is hermes/<slug>, made unique against existing branches", () => {
    expect(defaultTaskBranch("task-ab12", ["main"])).toBe("hermes/task-ab12");
    expect(defaultTaskBranch("task-ab12", ["main", "hermes/task-ab12"])).toBe("hermes/task-ab12-2");
    expect(defaultTaskBranch("task-ab12", ["hermes/task-ab12", "hermes/task-ab12-2"])).toBe("hermes/task-ab12-3");
    expect(defaultTaskBranch("!!!", [])).toBe("hermes/task");
  });
});

describe("pickRestoreId (D2: a restored session keeps its id)", () => {
  const fresh = () => "fresh-id-0000";
  it("keeps the saved id", () => {
    expect(pickRestoreId("3f0c2a1e-1111-4222-8333-944445555666", new Set(), fresh)).toBe(
      "3f0c2a1e-1111-4222-8333-944445555666",
    );
  });
  it("uses a fresh id only when the saved one is unusable or already taken", () => {
    expect(pickRestoreId("abcdefgh-1", new Set(["abcdefgh-1"]), fresh)).toBe("fresh-id-0000");
    expect(pickRestoreId(undefined, new Set(), fresh)).toBe("fresh-id-0000");
    expect(pickRestoreId("../../etc", new Set(), fresh)).toBe("fresh-id-0000");
    expect(pickRestoreId("short", new Set(), fresh)).toBe("fresh-id-0000");
  });
});

// ─── createSessionWorktrees ─────────────────────────────────────────

const ok = (branch: string, path = `/tmp/hermes-test/wt/${branch}`): WorktreeCreateResult => ({
  worktreePath: path,
  branchName: branch,
  isMainWorktree: false,
});

function deps(overrides: Partial<WorktreeDeps> = {}, answers: BranchConflictChoice[] = []) {
  const d = {
    createWorktree: vi.fn(async (_s: string, _p: string, branch: string) => ok(branch)),
    attachWorktree: vi.fn(async (_s: string, _p: string, branch: string) => ok(branch, "/tmp/hermes-test/other")),
    removeWorktree: vi.fn(async () => undefined),
    detachWorktree: vi.fn(async () => undefined),
    resolveConflict: vi.fn(async (): Promise<BranchConflictChoice> => answers.shift() ?? { kind: "cancel" }),
    ...overrides,
  };
  return d;
}

describe("createSessionWorktrees", () => {
  it("creates one worktree per selected project and skips unselected ones", async () => {
    const d = deps();
    const out = await createSessionWorktrees("s1", ["p1", "p2", "p3"], {
      p1: { branch: "hermes/task-a", createNew: true },
      p3: { branch: "feature", createNew: false, fromRemote: "origin/feature" },
    }, d);
    expect(out).toEqual({ succeeded: 2, errors: [], sharedBranches: [], cancelled: false });
    expect(d.createWorktree.mock.calls).toEqual([
      ["s1", "p1", "hermes/task-a", true, undefined, undefined],
      ["s1", "p3", "feature", false, "origin/feature", undefined],
    ]);
    expect(d.resolveConflict).not.toHaveBeenCalled();
  });

  it("never shares a checkout without asking: reuse only after the user says so", async () => {
    const d = deps(
      { createWorktree: vi.fn(async () => { throw inUse("main", "/tmp/hermes-test/repo", { projectFolder: true }); }) },
      [{ kind: "reuse" }],
    );
    const out = await createSessionWorktrees("s1", ["p1"], { p1: { branch: "main", createNew: false } }, d);
    expect(d.resolveConflict).toHaveBeenCalledWith({
      branch: "main", path: "/tmp/hermes-test/repo", sessionId: null, projectFolder: true, projectId: "p1",
    });
    expect(d.attachWorktree).toHaveBeenCalledWith("s1", "p1", "main");
    expect(out).toEqual({ succeeded: 1, errors: [], sharedBranches: ["main"], cancelled: false });
  });

  it("'use <branch>-2' creates a new branch cut from the branch in use", async () => {
    const create = vi.fn(async (_s: string, _p: string, branch: string) => {
      if (branch === "hermes/a") throw inUse("hermes/a", "/tmp/hermes-test/wt/a", { sessionId: "other" });
      return ok(branch);
    });
    const d = deps({ createWorktree: create }, [{ kind: "new-branch", name: "hermes/a-2" }]);
    const out = await createSessionWorktrees("s1", ["p1"], { p1: { branch: "hermes/a", createNew: false } }, d);
    expect(create.mock.calls[1]).toEqual(["s1", "p1", "hermes/a-2", true, undefined, "hermes/a"]);
    expect(d.attachWorktree).not.toHaveBeenCalled();
    expect(out).toEqual({ succeeded: 1, errors: [], sharedBranches: [], cancelled: false });
  });

  it("cancel undoes what was made: removes own worktrees, only unlinks shared ones", async () => {
    const create = vi.fn(async (_s: string, p: string, branch: string) => {
      if (p === "p3") throw inUse("x", "/tmp/hermes-test/x");
      if (p === "p2") throw inUse("y", "/tmp/hermes-test/y");
      return ok(branch);
    });
    const d = deps({ createWorktree: create }, [{ kind: "reuse" }, { kind: "cancel" }]);
    const out = await createSessionWorktrees("s1", ["p1", "p2", "p3"], {
      p1: { branch: "a", createNew: true },
      p2: { branch: "y", createNew: false },
      p3: { branch: "x", createNew: false },
    }, d);
    expect(out.cancelled).toBe(true);
    expect(d.removeWorktree.mock.calls).toEqual([["s1", "p1"]]);
    expect(d.detachWorktree.mock.calls).toEqual([["s1", "p2"]]);
  });

  it("other errors are reported, not turned into a shared checkout", async () => {
    const d = deps({ createWorktree: vi.fn(async () => { throw new Error("disk full"); }) });
    const out = await createSessionWorktrees("s1", ["p1"], { p1: { branch: "a", createNew: true } }, d);
    expect(out).toEqual({ succeeded: 0, errors: ["p1: disk full"], sharedBranches: [], cancelled: false });
    expect(d.resolveConflict).not.toHaveBeenCalled();
    expect(d.attachWorktree).not.toHaveBeenCalled();
  });

  it("stops asking after a few rounds of new names that are also in use", async () => {
    const d = deps(
      { createWorktree: vi.fn(async (_s: string, _p: string, b: string) => { throw inUse(b, "/tmp/hermes-test/z"); }) },
      Array.from({ length: 10 }, (_, i) => ({ kind: "new-branch" as const, name: `b-${i}` })),
    );
    const out = await createSessionWorktrees("s1", ["p1"], { p1: { branch: "b", createNew: false } }, d);
    expect(d.resolveConflict.mock.calls.length).toBe(5);
    expect(out.succeeded).toBe(0);
    expect(out.errors).toHaveLength(1);
  });
});

describe("closeCommitMessage", () => {
  it("names the session", () => {
    expect(closeCommitMessage("Fix login", "session")).toBe('Work in progress from Hermes session "Fix login"');
    expect(closeCommitMessage(" ", "archive")).toBe('Archive uncommitted work from Hermes session "session"');
  });
});

describe("shouldAskAboutChangesOnClose", () => {
  const wt = (over: Partial<SessionWorktree> = {}): SessionWorktree => ({
    id: "r1",
    sessionId: "s1",
    projectId: "p1",
    worktreePath: "/tmp/hermes-test/wt",
    branchName: "hermes/task-a",
    isMainWorktree: false,
    createdAt: "2026-01-01",
    ...over,
  });

  it("asks about a worktree the session owns alone", () => {
    expect(shouldAskAboutChangesOnClose(wt(), true)).toBe(true);
    expect(shouldAskAboutChangesOnClose(wt(), false)).toBe(true);
  });

  it("never asks about a checkout another session also works in", () => {
    expect(shouldAskAboutChangesOnClose(wt({ sharedWithOtherSessions: true }), true)).toBe(false);
    expect(shouldAskAboutChangesOnClose(wt({ sharedWithOtherSessions: true }), false)).toBe(false);
  });

  it("with honest isolation, skips the project folder and projects without a worktree", () => {
    expect(shouldAskAboutChangesOnClose(wt({ isMainWorktree: true }), true)).toBe(false);
    expect(shouldAskAboutChangesOnClose(null, true)).toBe(false);
  });

  it("without it, keeps checking the project folder as before", () => {
    expect(shouldAskAboutChangesOnClose(wt({ isMainWorktree: true }), false)).toBe(true);
    expect(shouldAskAboutChangesOnClose(null, false)).toBe(true);
  });

  it("never asks about a checkout Hermes did not make (reused external worktree), flag on or off", () => {
    const external = wt({ worktreePath: "/work/repo-external-wt", branchName: "external", ownedBySession: false });
    expect(shouldAskAboutChangesOnClose(external, true)).toBe(false);
    expect(shouldAskAboutChangesOnClose(external, false)).toBe(false);
    // The backend's verdict wins over the path when it says the checkout is ours.
    expect(shouldAskAboutChangesOnClose(wt({ ownedBySession: true }), true)).toBe(true);
    // An older backend without the field: a linked worktree is treated as ours.
    expect(shouldAskAboutChangesOnClose(wt({ ownedBySession: undefined }), true)).toBe(true);
  });
});

describe("describeBranchHolder", () => {
  const conflict = { branch: "feature", path: "/work/repo-external-wt", sessionId: null, projectFolder: false };

  it("names the project folder, the session, or the folder of an external checkout", () => {
    expect(describeBranchHolder({ ...conflict, projectFolder: true }, null)).toBe("the project folder");
    expect(describeBranchHolder({ ...conflict, sessionId: "s1" }, "Fix login")).toBe('session "Fix login"');
    expect(describeBranchHolder(conflict, null)).toBe("a checkout outside Hermes");
  });
});

describe("workingDirectoryRecoveryMessage", () => {
  const base = { sessionId: "s1", branchName: "hermes/task-a", missingPath: "/data/hermes-worktrees/x/s1_a", path: "/work/repo" };

  it("says what was missing and where the session opened", () => {
    expect(workingDirectoryRecoveryMessage({ ...base, outcome: "recreated", path: base.missingPath }))
      .toBe("The working folder of branch 'hermes/task-a' was missing and has been recreated.");
    expect(workingDirectoryRecoveryMessage({ ...base, outcome: "project-folder" }))
      .toBe("The working folder of branch 'hermes/task-a' is gone; the session opened in the project folder instead.");
    expect(workingDirectoryRecoveryMessage({ ...base, branchName: null, outcome: "home", path: "/tmp/home" }))
      .toBe("The working folder '/data/hermes-worktrees/x/s1_a' is gone; the session opened in your home folder instead.");
  });
});
