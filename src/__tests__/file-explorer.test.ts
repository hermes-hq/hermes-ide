/**
 * Tests for the File Explorer Panel feature.
 *
 * - Pure helpers: sortEntries, filterEntries, buildTreePath
 * - Reducer tests for TOGGLE_FILE_EXPLORER and SET_LEFT_TAB with "files"
 * - FileEntry type factory tests
 * - Integration: activity bar tab count
 */
import { describe, it, expect, vi } from "vitest";

// ─── Mock Tauri APIs ─────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("mocked"))),
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
  notifyStuck: vi.fn(),
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { sessionReducer, initialState } from "../state/SessionContext";
import { sortEntries, filterEntries, buildTreePath } from "../hooks/useFileTree";
import type { FileEntry } from "../types/git";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeFileEntry(overrides?: Partial<FileEntry>): FileEntry {
  return {
    name: "index.ts",
    path: "src/index.ts",
    is_dir: false,
    is_hidden: false,
    size: 1024,
    git_status: null,
    ...overrides,
  };
}

function makeDirEntry(overrides?: Partial<FileEntry>): FileEntry {
  return {
    name: "src",
    path: "src",
    is_dir: true,
    is_hidden: false,
    size: null,
    git_status: null,
    ...overrides,
  };
}

// ─── sortEntries ────────────────────────────────────────────────────

describe("sortEntries", () => {
  it("directories come before files", () => {
    const entries = [
      makeFileEntry({ name: "index.ts", path: "index.ts" }),
      makeDirEntry({ name: "src", path: "src" }),
      makeFileEntry({ name: "README.md", path: "README.md" }),
    ];
    const sorted = sortEntries(entries);
    expect(sorted[0].is_dir).toBe(true);
    expect(sorted[0].name).toBe("src");
  });

  it("alphabetical within directories", () => {
    const entries = [
      makeDirEntry({ name: "utils", path: "utils" }),
      makeDirEntry({ name: "components", path: "components" }),
      makeDirEntry({ name: "api", path: "api" }),
    ];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["api", "components", "utils"]);
  });

  it("alphabetical within files", () => {
    const entries = [
      makeFileEntry({ name: "z.ts", path: "z.ts" }),
      makeFileEntry({ name: "a.ts", path: "a.ts" }),
      makeFileEntry({ name: "m.ts", path: "m.ts" }),
    ];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["a.ts", "m.ts", "z.ts"]);
  });

  it("case-insensitive sorting", () => {
    const entries = [
      makeFileEntry({ name: "Readme.md", path: "Readme.md" }),
      makeFileEntry({ name: "api.ts", path: "api.ts" }),
      makeFileEntry({ name: "Package.json", path: "Package.json" }),
    ];
    const sorted = sortEntries(entries);
    expect(sorted.map((e) => e.name)).toEqual(["api.ts", "Package.json", "Readme.md"]);
  });

  it("empty array returns empty", () => {
    expect(sortEntries([])).toEqual([]);
  });
});

// ─── filterEntries ──────────────────────────────────────────────────

describe("filterEntries", () => {
  const entries = [
    makeFileEntry({ name: "index.ts", path: "index.ts" }),
    makeFileEntry({ name: ".env", path: ".env", is_hidden: true }),
    makeDirEntry({ name: ".config", path: ".config", is_hidden: true }),
    makeFileEntry({ name: "app.tsx", path: "app.tsx" }),
    makeDirEntry({ name: "src", path: "src" }),
  ];

  it("empty query returns all (respecting showHidden)", () => {
    const withHidden = filterEntries(entries, "", true);
    expect(withHidden).toHaveLength(5);
    const withoutHidden = filterEntries(entries, "", false);
    expect(withoutHidden).toHaveLength(3);
  });

  it("filters by partial name match", () => {
    const result = filterEntries(entries, "app", true);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("app.tsx");
  });

  it("case-insensitive filter", () => {
    const result = filterEntries(entries, "INDEX", true);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("index.ts");
  });

  it("showHidden=false excludes dotfiles", () => {
    const result = filterEntries(entries, "", false);
    expect(result.every((e) => !e.is_hidden)).toBe(true);
  });

  it("showHidden=true includes dotfiles", () => {
    const result = filterEntries(entries, "", true);
    expect(result.some((e) => e.is_hidden)).toBe(true);
  });

  it("directories are shown when they match (even if hidden)", () => {
    const result = filterEntries(entries, ".config", true);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe(".config");
    expect(result[0].is_dir).toBe(true);
  });
});

// ─── buildTreePath ──────────────────────────────────────────────────

describe("buildTreePath", () => {
  it("root level", () => {
    expect(buildTreePath("", "src")).toBe("src");
  });

  it("nested", () => {
    expect(buildTreePath("src", "components")).toBe("src/components");
  });

  it("handles trailing slash", () => {
    expect(buildTreePath("src/", "components")).toBe("src/components");
  });

  it("empty name returns parent path", () => {
    expect(buildTreePath("src/components", "")).toBe("src/components");
  });
});

// ─── Reducer: TOGGLE_FILE_EXPLORER ──────────────────────────────────

describe("Reducer: TOGGLE_FILE_EXPLORER", () => {
  it("opens file explorer, closes others", () => {
    const state = sessionReducer(initialState, { type: "TOGGLE_FILE_EXPLORER" });
    expect(state.ui.fileExplorerOpen).toBe(true);
    expect(state.ui.processPanelOpen).toBe(false);
    expect(state.ui.gitPanelOpen).toBe(false);
    expect(state.ui.activeLeftTab).toBe("files");
  });

  it("toggles back to sessions on second toggle", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_FILE_EXPLORER" });
    const state2 = sessionReducer(state1, { type: "TOGGLE_FILE_EXPLORER" });
    expect(state2.ui.fileExplorerOpen).toBe(false);
    expect(state2.ui.activeLeftTab).toBe("sessions");
  });

  it("closes git panel when opening files", () => {
    const withGit = sessionReducer(initialState, { type: "TOGGLE_GIT_PANEL" });
    expect(withGit.ui.gitPanelOpen).toBe(true);
    const state = sessionReducer(withGit, { type: "TOGGLE_FILE_EXPLORER" });
    expect(state.ui.fileExplorerOpen).toBe(true);
    expect(state.ui.gitPanelOpen).toBe(false);
  });

  it("closes process panel when opening files", () => {
    const withProcesses = sessionReducer(initialState, { type: "TOGGLE_PROCESS_PANEL" });
    expect(withProcesses.ui.processPanelOpen).toBe(true);
    const state = sessionReducer(withProcesses, { type: "TOGGLE_FILE_EXPLORER" });
    expect(state.ui.fileExplorerOpen).toBe(true);
    expect(state.ui.processPanelOpen).toBe(false);
  });

  it("SET_LEFT_TAB with 'files' works correctly", () => {
    const state = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "files" });
    expect(state.ui.fileExplorerOpen).toBe(true);
    expect(state.ui.activeLeftTab).toBe("files");
  });
});

// ─── Reducer: SET_LEFT_TAB with files ───────────────────────────────

describe("Reducer: SET_LEFT_TAB with files", () => {
  it("switches to files tab correctly", () => {
    const state = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "files" });
    expect(state.ui.activeLeftTab).toBe("files");
    expect(state.ui.fileExplorerOpen).toBe(true);
    expect(state.ui.processPanelOpen).toBe(false);
    expect(state.ui.gitPanelOpen).toBe(false);
    expect(state.ui.sessionListCollapsed).toBe(true);
  });

  it("mutual exclusion with other tabs", () => {
    const withGit = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "git" });
    const state = sessionReducer(withGit, { type: "SET_LEFT_TAB", tab: "files" });
    expect(state.ui.fileExplorerOpen).toBe(true);
    expect(state.ui.gitPanelOpen).toBe(false);
    expect(state.ui.processPanelOpen).toBe(false);
  });

  it("clicking active files tab collapses", () => {
    const withFiles = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "files" });
    const state = sessionReducer(withFiles, { type: "SET_LEFT_TAB", tab: "files" });
    expect(state.ui.fileExplorerOpen).toBe(false);
    expect(state.ui.sessionListCollapsed).toBe(true);
  });

  it("other tabs close file explorer", () => {
    const withFiles = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "files" });
    const state = sessionReducer(withFiles, { type: "SET_LEFT_TAB", tab: "sessions" });
    expect(state.ui.fileExplorerOpen).toBe(false);
    expect(state.ui.sessionListCollapsed).toBe(false);
  });
});

// ─── FileEntry type factory ─────────────────────────────────────────

describe("FileEntry type factory", () => {
  it("factory produces valid file entry", () => {
    const file = makeFileEntry();
    expect(file.name).toBe("index.ts");
    expect(file.is_dir).toBe(false);
    expect(file.size).toBe(1024);
    expect(file.git_status).toBeNull();
  });

  it("factory produces valid directory entry", () => {
    const dir = makeDirEntry();
    expect(dir.name).toBe("src");
    expect(dir.is_dir).toBe(true);
    expect(dir.size).toBeNull();
  });

  it("git status mapping covers all statuses", () => {
    const statuses = ["modified", "added", "deleted", "renamed", "untracked", "conflicted"];
    for (const status of statuses) {
      const entry = makeFileEntry({ git_status: status });
      expect(entry.git_status).toBe(status);
    }
  });
});

// ─── Integration: activity bar tab count ────────────────────────────

describe("Integration: activity bar tab count", () => {
  it("initial state has 4 tab-compatible boolean flags", () => {
    // sessions (sessionListCollapsed=false), processes, git, files
    expect(initialState.ui.processPanelOpen).toBe(false);
    expect(initialState.ui.gitPanelOpen).toBe(false);
    expect(initialState.ui.fileExplorerOpen).toBe(false);
    expect(initialState.ui.sessionListCollapsed).toBe(false);
  });

  it("files tab is mutually exclusive with others", () => {
    // Open files → check all others closed
    const withFiles = sessionReducer(initialState, { type: "TOGGLE_FILE_EXPLORER" });
    expect(withFiles.ui.fileExplorerOpen).toBe(true);
    expect(withFiles.ui.processPanelOpen).toBe(false);
    expect(withFiles.ui.gitPanelOpen).toBe(false);

    // Open git → files should be closed
    const withGit = sessionReducer(withFiles, { type: "TOGGLE_GIT_PANEL" });
    expect(withGit.ui.gitPanelOpen).toBe(true);
    expect(withGit.ui.fileExplorerOpen).toBe(false);
  });

  it("initial state has fileExplorerOpen=false", () => {
    expect(initialState.ui.fileExplorerOpen).toBe(false);
  });
});
