/**
 * Tests for git context menus: file rows, branches, commits, stashes.
 *
 * - Correct Stage/Unstage toggling per file status
 * - Branch actions per current/remote/local state
 * - Commit message availability
 * - Stash action completeness
 * - Edge cases: binary files, conflicts, current branch, remote branches
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import {
  buildGitFileMenuItems,
  buildBranchMenuItems,
  buildCommitMenuItems,
  buildStashMenuItems,
} from "../hooks/useContextMenu";

const SRC = resolve(__dirname, "..");
function readSrc(path: string): string {
  return readFileSync(resolve(SRC, path), "utf-8");
}

function findItem(items: { id: string }[], id: string) {
  return items.find((i) => i.id === id);
}

// ─── Git File Menu: Status Variants ─────────────────────────────────

describe("git file menu — status variants", () => {
  it("modified file: Stage, Diff enabled, Discard enabled", () => {
    const items = buildGitFileMenuItems({ path: "a.ts", status: "modified" });
    expect(findItem(items, "git-file.stage")).toBeDefined();
    expect(findItem(items, "git-file.diff")!.enabled).toBe(true);
    expect(findItem(items, "git-file.discard")!.enabled).toBe(true);
  });

  it("deleted file: Stage, Diff enabled, Discard enabled", () => {
    const items = buildGitFileMenuItems({ path: "a.ts", status: "deleted" });
    expect(findItem(items, "git-file.stage")).toBeDefined();
    expect(findItem(items, "git-file.diff")!.enabled).toBe(true);
  });

  it("renamed file: Stage, Diff enabled", () => {
    const items = buildGitFileMenuItems({ path: "a.ts", status: "renamed" });
    expect(findItem(items, "git-file.stage")).toBeDefined();
    expect(findItem(items, "git-file.diff")!.enabled).toBe(true);
  });

  it("untracked file: Stage, Diff disabled, Discard disabled", () => {
    const items = buildGitFileMenuItems({ path: "new.txt", status: "untracked" });
    expect(findItem(items, "git-file.stage")).toBeDefined();
    expect(findItem(items, "git-file.diff")!.enabled).toBe(false);
    expect(findItem(items, "git-file.discard")!.enabled).toBe(false);
  });

  it("new file: Stage, Diff disabled", () => {
    const items = buildGitFileMenuItems({ path: "new.txt", status: "new" });
    expect(findItem(items, "git-file.stage")).toBeDefined();
    expect(findItem(items, "git-file.diff")!.enabled).toBe(false);
  });

  it("staged_modified: Unstage", () => {
    const items = buildGitFileMenuItems({ path: "a.ts", status: "staged_modified" });
    expect(findItem(items, "git-file.unstage")).toBeDefined();
    expect(findItem(items, "git-file.stage")).toBeUndefined();
  });

  it("added: Unstage", () => {
    const items = buildGitFileMenuItems({ path: "a.ts", status: "added" });
    expect(findItem(items, "git-file.unstage")).toBeDefined();
  });

  it("conflicted file: Stage available", () => {
    const items = buildGitFileMenuItems({ path: "a.ts", status: "conflicted" });
    expect(findItem(items, "git-file.stage")).toBeDefined();
  });

  it("all status variants include Copy Path", () => {
    for (const status of ["modified", "added", "deleted", "untracked", "renamed", "conflicted"]) {
      const items = buildGitFileMenuItems({ path: "a.ts", status });
      expect(findItem(items, "git-file.copy-path")).toBeDefined();
    }
  });

  it("all status variants include Reveal in Finder", () => {
    for (const status of ["modified", "added", "deleted", "untracked"]) {
      const items = buildGitFileMenuItems({ path: "a.ts", status });
      expect(findItem(items, "git-file.reveal")).toBeDefined();
    }
  });

  it("all status variants include Open in Terminal", () => {
    for (const status of ["modified", "added", "deleted", "untracked"]) {
      const items = buildGitFileMenuItems({ path: "a.ts", status });
      expect(findItem(items, "git-file.open-terminal")).toBeDefined();
    }
  });
});

// ─── Git Branch Menu ────────────────────────────────────────────────

describe("git branch menu — edge cases", () => {
  it("current local branch: cannot checkout, merge, or delete", () => {
    const items = buildBranchMenuItems({ name: "main", is_remote: false }, "main");
    expect(findItem(items, "branch.checkout")!.enabled).toBe(false);
    expect(findItem(items, "branch.merge")!.enabled).toBe(false);
    expect(findItem(items, "branch.delete")!.enabled).toBe(false);
  });

  it("non-current local branch: all actions enabled", () => {
    const items = buildBranchMenuItems({ name: "feature", is_remote: false }, "main");
    expect(findItem(items, "branch.checkout")!.enabled).toBe(true);
    expect(findItem(items, "branch.merge")!.enabled).toBe(true);
    expect(findItem(items, "branch.delete")!.enabled).toBe(true);
  });

  it("remote branch: checkout enabled, delete disabled", () => {
    const items = buildBranchMenuItems({ name: "origin/main", is_remote: true }, "feature");
    expect(findItem(items, "branch.checkout")!.enabled).toBe(true);
    expect(findItem(items, "branch.delete")!.enabled).toBe(false);
  });

  it("Copy Branch Name always enabled even for current branch", () => {
    const items = buildBranchMenuItems({ name: "main", is_remote: false }, "main");
    expect(findItem(items, "branch.copy-name")!.enabled).toBe(true);
  });

  it("branch menu has separators between action groups", () => {
    const items = buildBranchMenuItems({ name: "feature", is_remote: false }, "main");
    const seps = items.filter((i) => i.is_separator);
    expect(seps.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Git Commit Menu ────────────────────────────────────────────────

describe("git commit menu", () => {
  it("Copy SHA is always the first action", () => {
    const items = buildCommitMenuItems({ sha: "abc123" });
    expect(items[0].id).toBe("commit.copy-sha");
  });

  it("Copy Message enabled when message provided", () => {
    const items = buildCommitMenuItems({ sha: "abc", message: "Fix" });
    expect(findItem(items, "commit.copy-message")!.enabled).toBe(true);
  });

  it("Copy Message disabled when no message", () => {
    const items = buildCommitMenuItems({ sha: "abc" });
    expect(findItem(items, "commit.copy-message")!.enabled).toBe(false);
  });

  it("View Details action exists", () => {
    const items = buildCommitMenuItems({ sha: "abc" });
    expect(findItem(items, "commit.view-details")).toBeDefined();
  });

  it("Checkout Commit action exists", () => {
    const items = buildCommitMenuItems({ sha: "abc" });
    expect(findItem(items, "commit.checkout")).toBeDefined();
  });
});

// ─── Git Stash Menu ─────────────────────────────────────────────────

describe("git stash menu", () => {
  it("Apply is always the first action", () => {
    const items = buildStashMenuItems({ index: 0 });
    expect(items[0].id).toBe("stash.apply");
  });

  it("Pop is always the second action", () => {
    const items = buildStashMenuItems({ index: 0 });
    expect(items[1].id).toBe("stash.pop");
  });

  it("Drop is separated from Apply/Pop", () => {
    const items = buildStashMenuItems({ index: 0 });
    const dropIdx = items.findIndex((i) => i.id === "stash.drop");
    expect(items[dropIdx - 1].is_separator).toBe(true);
  });

  it("all actions are enabled by default", () => {
    const items = buildStashMenuItems({ index: 0 });
    const actions = items.filter((i) => !i.is_separator);
    for (const action of actions) {
      expect(action.enabled).toBe(true);
    }
  });

  it("works with any stash index", () => {
    const items0 = buildStashMenuItems({ index: 0 });
    const items5 = buildStashMenuItems({ index: 5 });
    expect(items0.length).toBe(items5.length);
  });
});

// ─── Source Invariants ──────────────────────────────────────────────

describe("git component source invariants", () => {
  it("GitFileRow.tsx accepts onContextMenu prop", () => {
    const src = readSrc("components/GitFileRow.tsx");
    expect(src).toContain("onContextMenu");
  });

  it("GitBranchSelector.tsx uses useContextMenu hook", () => {
    const src = readSrc("components/GitBranchSelector.tsx");
    expect(src).toContain("useContextMenu");
  });

  it("GitLogView.tsx uses useContextMenu hook", () => {
    const src = readSrc("components/GitLogView.tsx");
    expect(src).toContain("useContextMenu");
  });

  it("GitStashSection.tsx uses useContextMenu hook", () => {
    const src = readSrc("components/GitStashSection.tsx");
    expect(src).toContain("useContextMenu");
  });
});
