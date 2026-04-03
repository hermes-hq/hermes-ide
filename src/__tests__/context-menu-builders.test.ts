/**
 * Tests for all pure context menu builder functions.
 *
 * Builder functions are the primary testing surface for context menus:
 * given input state, they produce a deterministic array of menu items.
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import {
  buildTerminalMenuItems,
  buildSessionMenuItems,
  buildGitFileMenuItems,
  buildBranchMenuItems,
  buildCommitMenuItems,
  buildStashMenuItems,
  buildFileExplorerMenuItems,
  buildProcessMenuItems,
  buildSearchResultMenuItems,
  buildContextEntryMenuItems,
  buildPaneHeaderMenuItems,
  buildTextInputMenuItems,
  buildEmptyAreaMenuItems,
} from "../hooks/useContextMenu";

// ─── Helpers ─────────────────────────────────────────────────────────

function findItem(items: { id: string }[], id: string) {
  return items.find((i) => i.id === id);
}

function findSeparators(items: { is_separator?: boolean }[]) {
  return items.filter((i) => i.is_separator);
}

// ─── Terminal Menu ──────────────────────────────────────────────────

describe("buildTerminalMenuItems", () => {
  it("returns Copy disabled when no selection", () => {
    const items = buildTerminalMenuItems(false);
    const copy = findItem(items, "terminal.copy");
    expect(copy).toBeDefined();
    expect(copy!.enabled).toBe(false);
  });

  it("returns Copy enabled when selection exists", () => {
    const items = buildTerminalMenuItems(true);
    const copy = findItem(items, "terminal.copy");
    expect(copy!.enabled).toBe(true);
  });

  it("always includes Paste enabled", () => {
    const items = buildTerminalMenuItems(false);
    const paste = findItem(items, "terminal.paste");
    expect(paste).toBeDefined();
    expect(paste!.enabled).toBe(true);
  });

  it("includes split actions", () => {
    const items = buildTerminalMenuItems(false);
    expect(findItem(items, "terminal.split-right")).toBeDefined();
    expect(findItem(items, "terminal.split-down")).toBeDefined();
  });

  it("includes separators between groups", () => {
    const items = buildTerminalMenuItems(false);
    expect(findSeparators(items).length).toBeGreaterThanOrEqual(2);
  });

  it("includes search item", () => {
    const items = buildTerminalMenuItems(false);
    expect(findItem(items, "terminal.search")).toBeDefined();
  });
});

// ─── Session Menu ───────────────────────────────────────────────────

describe("buildSessionMenuItems", () => {
  const session = { id: "s1", group: null, phase: "idle" };

  it("always includes Rename", () => {
    const items = buildSessionMenuItems(session, []);
    expect(findItem(items, "session.rename")).toBeDefined();
  });

  it("includes New Group when no groups exist", () => {
    const items = buildSessionMenuItems(session, []);
    expect(findItem(items, "session.new-group")).toBeDefined();
  });

  it("includes group submenu when groups exist", () => {
    const items = buildSessionMenuItems(session, ["dev", "staging"]);
    const groupSub = items.find((i) => i.label === "Project");
    expect(groupSub).toBeDefined();
    expect(groupSub!.children).toBeDefined();
    expect(groupSub!.children!.length).toBeGreaterThanOrEqual(2);
  });

  it("includes Remove from Group when session has a group", () => {
    const grouped = { id: "s1", group: "dev", phase: "idle" };
    const items = buildSessionMenuItems(grouped, ["dev"]);
    const groupSub = items.find((i) => i.label === "Project");
    const remove = groupSub?.children?.find((c: { id: string }) => c.id === "session.remove-group");
    expect(remove).toBeDefined();
  });

  it("does not include Remove from Group when no group", () => {
    const items = buildSessionMenuItems(session, ["dev"]);
    const groupSub = items.find((i) => i.label === "Project");
    const remove = groupSub?.children?.find((c: { id: string }) => c.id === "session.remove-group");
    expect(remove).toBeUndefined();
  });

  it("includes Close Session", () => {
    const items = buildSessionMenuItems(session, []);
    expect(findItem(items, "session.close")).toBeDefined();
  });

  it("does not include Duplicate Session", () => {
    const items = buildSessionMenuItems(session, []);
    expect(findItem(items, "session.duplicate")).toBeUndefined();
  });
});

// ─── Git File Menu ──────────────────────────────────────────────────

describe("buildGitFileMenuItems", () => {
  it("shows Stage for unstaged files", () => {
    const items = buildGitFileMenuItems({ path: "src/foo.ts", status: "modified" });
    const stageItem = items.find((i) => i.id === "git-file.stage");
    expect(stageItem).toBeDefined();
    expect(stageItem!.label).toBe("Stage");
  });

  it("shows Unstage for staged files", () => {
    const items = buildGitFileMenuItems({ path: "src/foo.ts", status: "staged_modified" });
    const unstageItem = items.find((i) => i.id === "git-file.unstage");
    expect(unstageItem).toBeDefined();
    expect(unstageItem!.label).toBe("Unstage");
  });

  it("shows Unstage for added files", () => {
    const items = buildGitFileMenuItems({ path: "src/foo.ts", status: "added" });
    expect(items.find((i) => i.id === "git-file.unstage")).toBeDefined();
  });

  it("disables View Diff for untracked files", () => {
    const items = buildGitFileMenuItems({ path: "new.txt", status: "untracked" });
    const diff = findItem(items, "git-file.diff");
    expect(diff!.enabled).toBe(false);
  });

  it("enables View Diff for modified files", () => {
    const items = buildGitFileMenuItems({ path: "src/foo.ts", status: "modified" });
    const diff = findItem(items, "git-file.diff");
    expect(diff!.enabled).toBe(true);
  });

  it("disables Discard Changes for untracked files", () => {
    const items = buildGitFileMenuItems({ path: "new.txt", status: "untracked" });
    const discard = findItem(items, "git-file.discard");
    expect(discard!.enabled).toBe(false);
  });

  it("includes Copy Path and Reveal", () => {
    const items = buildGitFileMenuItems({ path: "src/foo.ts", status: "modified" });
    expect(findItem(items, "git-file.copy-path")).toBeDefined();
    expect(findItem(items, "git-file.reveal")).toBeDefined();
    expect(findItem(items, "git-file.open-terminal")).toBeDefined();
  });
});

// ─── Branch Menu ────────────────────────────────────────────────────

describe("buildBranchMenuItems", () => {
  it("disables Checkout for current branch", () => {
    const items = buildBranchMenuItems({ name: "main", is_remote: false }, "main");
    const checkout = findItem(items, "branch.checkout");
    expect(checkout!.enabled).toBe(false);
  });

  it("enables Checkout for non-current branch", () => {
    const items = buildBranchMenuItems({ name: "feature", is_remote: false }, "main");
    const checkout = findItem(items, "branch.checkout");
    expect(checkout!.enabled).toBe(true);
  });

  it("disables Merge for current branch", () => {
    const items = buildBranchMenuItems({ name: "main", is_remote: false }, "main");
    const merge = findItem(items, "branch.merge");
    expect(merge!.enabled).toBe(false);
  });

  it("disables Delete for current branch", () => {
    const items = buildBranchMenuItems({ name: "main", is_remote: false }, "main");
    const del = findItem(items, "branch.delete");
    expect(del!.enabled).toBe(false);
  });

  it("disables Delete for remote branches", () => {
    const items = buildBranchMenuItems({ name: "origin/main", is_remote: true }, "main");
    const del = findItem(items, "branch.delete");
    expect(del!.enabled).toBe(false);
  });

  it("enables Delete for non-current local branches", () => {
    const items = buildBranchMenuItems({ name: "feature", is_remote: false }, "main");
    const del = findItem(items, "branch.delete");
    expect(del!.enabled).toBe(true);
  });

  it("always includes Copy Branch Name", () => {
    const items = buildBranchMenuItems({ name: "main", is_remote: false }, "main");
    expect(findItem(items, "branch.copy-name")).toBeDefined();
  });
});

// ─── Commit Menu ────────────────────────────────────────────────────

describe("buildCommitMenuItems", () => {
  it("includes Copy SHA", () => {
    const items = buildCommitMenuItems({ sha: "abc123" });
    expect(findItem(items, "commit.copy-sha")).toBeDefined();
  });

  it("disables Copy Message when no message", () => {
    const items = buildCommitMenuItems({ sha: "abc123" });
    const msg = findItem(items, "commit.copy-message");
    expect(msg!.enabled).toBe(false);
  });

  it("enables Copy Message when message exists", () => {
    const items = buildCommitMenuItems({ sha: "abc123", message: "Fix bug" });
    const msg = findItem(items, "commit.copy-message");
    expect(msg!.enabled).toBe(true);
  });

  it("includes Checkout and View Details", () => {
    const items = buildCommitMenuItems({ sha: "abc123" });
    expect(findItem(items, "commit.checkout")).toBeDefined();
    expect(findItem(items, "commit.view-details")).toBeDefined();
  });
});

// ─── Stash Menu ─────────────────────────────────────────────────────

describe("buildStashMenuItems", () => {
  it("includes Apply, Pop, and Drop", () => {
    const items = buildStashMenuItems({ index: 0 });
    expect(findItem(items, "stash.apply")).toBeDefined();
    expect(findItem(items, "stash.pop")).toBeDefined();
    expect(findItem(items, "stash.drop")).toBeDefined();
  });

  it("has separator before Drop", () => {
    const items = buildStashMenuItems({ index: 0 });
    // Drop should be after a separator
    const dropIdx = items.findIndex((i) => i.id === "stash.drop");
    expect(items[dropIdx - 1].is_separator).toBe(true);
  });
});

// ─── File Explorer Menu ─────────────────────────────────────────────

describe("buildFileExplorerMenuItems", () => {
  it("includes New File/Folder for directories", () => {
    const items = buildFileExplorerMenuItems({ name: "src", is_dir: true, path: "/src" });
    expect(findItem(items, "file-explorer.new-file")).toBeDefined();
    expect(findItem(items, "file-explorer.new-folder")).toBeDefined();
  });

  it("omits New File/Folder for files", () => {
    const items = buildFileExplorerMenuItems({ name: "foo.ts", is_dir: false, path: "/src/foo.ts" });
    expect(findItem(items, "file-explorer.new-file")).toBeUndefined();
    expect(findItem(items, "file-explorer.new-folder")).toBeUndefined();
  });

  it("always includes Open in Terminal", () => {
    const items = buildFileExplorerMenuItems({ name: "foo.ts", is_dir: false, path: "/src/foo.ts" });
    expect(findItem(items, "file-explorer.open-terminal")).toBeDefined();
  });

  it("includes Rename, Delete, Copy Path, Reveal", () => {
    const items = buildFileExplorerMenuItems({ name: "foo.ts", is_dir: false, path: "/src/foo.ts" });
    expect(findItem(items, "file-explorer.rename")).toBeDefined();
    expect(findItem(items, "file-explorer.delete")).toBeDefined();
    expect(findItem(items, "file-explorer.copy-path")).toBeDefined();
    expect(findItem(items, "file-explorer.reveal")).toBeDefined();
  });
});

// ─── Process Menu ───────────────────────────────────────────────────

describe("buildProcessMenuItems", () => {
  it("includes Copy PID always", () => {
    const items = buildProcessMenuItems({ pid: 1234, is_protected: false }, false);
    expect(findItem(items, "process.copy-pid")).toBeDefined();
  });

  it("disables SIGTERM for protected processes", () => {
    const items = buildProcessMenuItems({ pid: 1, is_protected: true }, false);
    const term = findItem(items, "process.sigterm");
    expect(term!.enabled).toBe(false);
  });

  it("enables SIGTERM for non-protected processes", () => {
    const items = buildProcessMenuItems({ pid: 1234, is_protected: false }, false);
    const term = findItem(items, "process.sigterm");
    expect(term!.enabled).toBe(true);
  });

  it("omits SIGKILL and Kill Tree in non-advanced mode", () => {
    const items = buildProcessMenuItems({ pid: 1234, is_protected: false }, false);
    expect(findItem(items, "process.sigkill")).toBeUndefined();
    expect(findItem(items, "process.kill-tree")).toBeUndefined();
  });

  it("includes SIGKILL and Kill Tree in advanced mode", () => {
    const items = buildProcessMenuItems({ pid: 1234, is_protected: false }, true);
    expect(findItem(items, "process.sigkill")).toBeDefined();
    expect(findItem(items, "process.kill-tree")).toBeDefined();
  });

  it("disables SIGKILL for protected processes in advanced mode", () => {
    const items = buildProcessMenuItems({ pid: 1, is_protected: true }, true);
    expect(findItem(items, "process.sigkill")!.enabled).toBe(false);
    expect(findItem(items, "process.kill-tree")!.enabled).toBe(false);
  });

  it("includes Reveal when exe_path is present", () => {
    const items = buildProcessMenuItems({ pid: 1234, is_protected: false, exe_path: "/usr/bin/node" }, false);
    expect(findItem(items, "process.reveal")).toBeDefined();
  });

  it("omits Reveal when no exe_path", () => {
    const items = buildProcessMenuItems({ pid: 1234, is_protected: false }, false);
    expect(findItem(items, "process.reveal")).toBeUndefined();
  });
});

// ─── Search Result Menu ─────────────────────────────────────────────

describe("buildSearchResultMenuItems", () => {
  it("includes Open in Terminal, Copy Path, Reveal", () => {
    const items = buildSearchResultMenuItems({ path: "/src/foo.ts" });
    expect(findItem(items, "search.open-terminal")).toBeDefined();
    expect(findItem(items, "search.copy-path")).toBeDefined();
    expect(findItem(items, "search.reveal")).toBeDefined();
  });
});

// ─── Context Entry Menu ─────────────────────────────────────────────

describe("buildContextEntryMenuItems", () => {
  it("shows Pin for unpinned entries", () => {
    const items = buildContextEntryMenuItems({ pinned: false });
    const pin = findItem(items, "context.pin");
    expect(pin!.label).toBe("Pin");
  });

  it("shows Unpin for pinned entries", () => {
    const items = buildContextEntryMenuItems({ pinned: true });
    const unpin = findItem(items, "context.unpin");
    expect(unpin!.label).toBe("Unpin");
  });

  it("includes Remove and Copy Path", () => {
    const items = buildContextEntryMenuItems({});
    expect(findItem(items, "context.remove")).toBeDefined();
    expect(findItem(items, "context.copy-path")).toBeDefined();
  });
});

// ─── Timeline Menu ──────────────────────────────────────────────────

// ─── Pane Header Menu ───────────────────────────────────────────────

describe("buildPaneHeaderMenuItems", () => {
  it("disables Close Pane when no siblings", () => {
    const items = buildPaneHeaderMenuItems("pane-1", false);
    const close = findItem(items, "pane.close");
    expect(close!.enabled).toBe(false);
  });

  it("enables Close Pane when has siblings", () => {
    const items = buildPaneHeaderMenuItems("pane-1", true);
    const close = findItem(items, "pane.close");
    expect(close!.enabled).toBe(true);
  });

  it("disables Close Others when no siblings", () => {
    const items = buildPaneHeaderMenuItems("pane-1", false);
    const closeOthers = findItem(items, "pane.close-others");
    expect(closeOthers!.enabled).toBe(false);
  });

  it("includes Split Right and Split Down", () => {
    const items = buildPaneHeaderMenuItems("pane-1", false);
    expect(findItem(items, "pane.split-right")).toBeDefined();
    expect(findItem(items, "pane.split-down")).toBeDefined();
  });
});

// ─── Text Input Menu ────────────────────────────────────────────────

describe("buildTextInputMenuItems", () => {
  it("disables Cut and Copy when no selection", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.cut")!.enabled).toBe(false);
    expect(findItem(items, "text.copy")!.enabled).toBe(false);
  });

  it("enables Cut and Copy when selection exists", () => {
    const items = buildTextInputMenuItems(true);
    expect(findItem(items, "text.cut")!.enabled).toBe(true);
    expect(findItem(items, "text.copy")!.enabled).toBe(true);
  });

  it("always enables Paste and Select All", () => {
    const items = buildTextInputMenuItems(false);
    expect(findItem(items, "text.paste")!.enabled).toBe(true);
    expect(findItem(items, "text.select-all")!.enabled).toBe(true);
  });

  it("includes exactly 5 items (Cut, Copy, Paste, separator, Select All)", () => {
    const items = buildTextInputMenuItems(false);
    expect(items.length).toBe(5);
    expect(items[3].is_separator).toBe(true);
  });
});

// ─── Empty Area Menu ────────────────────────────────────────────────

describe("buildEmptyAreaMenuItems", () => {
  it("sidebar: includes New Session", () => {
    const items = buildEmptyAreaMenuItems("sidebar");
    expect(findItem(items, "empty.new-session")).toBeDefined();
  });

  it("file-explorer: includes New File, New Folder, Open Terminal", () => {
    const items = buildEmptyAreaMenuItems("file-explorer");
    expect(findItem(items, "empty.new-file")).toBeDefined();
    expect(findItem(items, "empty.new-folder")).toBeDefined();
    expect(findItem(items, "empty.open-terminal")).toBeDefined();
  });

  it("git-section: includes Refresh", () => {
    const items = buildEmptyAreaMenuItems("git-section");
    expect(findItem(items, "empty.refresh")).toBeDefined();
  });
});
