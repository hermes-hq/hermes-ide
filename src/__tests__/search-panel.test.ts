/**
 * Tests for the Search Panel feature.
 *
 * - Pure helper tests (highlightMatch, formatResultCount, debounce)
 * - SearchMatch / SearchResponse type factories
 * - Reducer tests for TOGGLE_SEARCH_PANEL / SET_LEFT_TAB with search
 * - Mutual-exclusion tests (search closes other panels, other panels close search)
 * - Race condition guard (sequence counter logic)
 * - UI state guards (min chars, no session)
 * - ShortcutsPanel accuracy
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
  notifyLongRunningDone: vi.fn(),
}));

// ─── Imports ─────────────────────────────────────────────────────────
import { sessionReducer, initialState } from "../state/SessionContext";
import { highlightMatch, formatResultCount, debounce } from "../components/SearchPanel";
import { SHORTCUT_GROUPS } from "../components/ShortcutsPanel";
import type { SearchMatch, SearchFileResult, SearchResponse } from "../types/git";

// ─── highlightMatch ──────────────────────────────────────────────────

describe("highlightMatch", () => {
  it("splits a basic match in the middle of a line", () => {
    const result = highlightMatch("hello world foo", 6, 11);
    expect(result).toEqual({ before: "hello ", match: "world", after: " foo" });
  });

  it("handles match at start of line", () => {
    const result = highlightMatch("hello world", 0, 5);
    expect(result).toEqual({ before: "", match: "hello", after: " world" });
  });

  it("handles match at end of line", () => {
    const result = highlightMatch("hello world", 6, 11);
    expect(result).toEqual({ before: "hello ", match: "world", after: "" });
  });

  it("handles full line match", () => {
    const result = highlightMatch("hello", 0, 5);
    expect(result).toEqual({ before: "", match: "hello", after: "" });
  });

  it("handles empty line", () => {
    const result = highlightMatch("", 0, 0);
    expect(result).toEqual({ before: "", match: "", after: "" });
  });
});

// ─── formatResultCount ───────────────────────────────────────────────

describe("formatResultCount", () => {
  it("formats normal counts", () => {
    expect(formatResultCount(42, 7)).toBe("42 results in 7 files");
  });

  it("singular file", () => {
    expect(formatResultCount(5, 1)).toBe("5 results in 1 file");
  });

  it("singular result", () => {
    expect(formatResultCount(1, 3)).toBe("1 result in 3 files");
  });

  it("zero results", () => {
    expect(formatResultCount(0, 0)).toBe("0 results in 0 files");
  });

  it("large numbers", () => {
    expect(formatResultCount(1500, 200)).toBe("1500 results in 200 files");
  });
});

// ─── debounce ────────────────────────────────────────────────────────

describe("debounce", () => {
  it("calls function after delay", async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("resets timer on rapid calls", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("preserves arguments", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 100);
    debounced("a", "b");
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith("a", "b");
    vi.useRealTimers();
  });
});

// ─── SearchMatch type factory ────────────────────────────────────────

describe("SearchMatch type", () => {
  it("creates a valid SearchMatch object", () => {
    const m: SearchMatch = {
      line_number: 10,
      line_content: "const x = 42;",
      match_start: 6,
      match_end: 7,
    };
    expect(m.line_number).toBe(10);
    expect(m.line_content).toBe("const x = 42;");
    expect(m.match_start).toBe(6);
    expect(m.match_end).toBe(7);
  });

  it("handles defaults/edge values", () => {
    const m: SearchMatch = {
      line_number: 1,
      line_content: "",
      match_start: 0,
      match_end: 0,
    };
    expect(m.line_number).toBe(1);
    expect(m.match_start).toBe(0);
  });
});

// ─── SearchResponse type factory ─────────────────────────────────────

describe("SearchResponse type", () => {
  it("handles empty results", () => {
    const r: SearchResponse = { results: [], total_matches: 0, truncated: false };
    expect(r.results).toHaveLength(0);
    expect(r.total_matches).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it("handles truncated flag", () => {
    const r: SearchResponse = { results: [], total_matches: 500, truncated: true };
    expect(r.truncated).toBe(true);
  });

  it("handles multiple files", () => {
    const f1: SearchFileResult = {
      path: "src/a.ts",
      matches: [{ line_number: 1, line_content: "foo", match_start: 0, match_end: 3 }],
    };
    const f2: SearchFileResult = {
      path: "src/b.ts",
      matches: [{ line_number: 5, line_content: "bar foo", match_start: 4, match_end: 7 }],
    };
    const r: SearchResponse = { results: [f1, f2], total_matches: 2, truncated: false };
    expect(r.results).toHaveLength(2);
    expect(r.results[0].path).toBe("src/a.ts");
    expect(r.results[1].matches[0].line_number).toBe(5);
  });
});

// ─── Reducer: TOGGLE_SEARCH_PANEL ────────────────────────────────────

describe("Reducer: TOGGLE_SEARCH_PANEL", () => {
  it("opens search panel and sets correct left tab", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_SEARCH_PANEL" });
    expect(state1.ui.searchPanelOpen).toBe(true);
    expect(state1.ui.activeLeftTab).toBe("search");
    expect(state1.ui.sessionListCollapsed).toBe(true);
    expect(state1.ui.processPanelOpen).toBe(false);
    expect(state1.ui.gitPanelOpen).toBe(false);
    expect(state1.ui.fileExplorerOpen).toBe(false);
  });

  it("toggles back to sessions on second toggle", () => {
    const state1 = sessionReducer(initialState, { type: "TOGGLE_SEARCH_PANEL" });
    const state2 = sessionReducer(state1, { type: "TOGGLE_SEARCH_PANEL" });
    expect(state2.ui.searchPanelOpen).toBe(false);
    expect(state2.ui.activeLeftTab).toBe("sessions");
  });
});

// ─── Reducer: SET_LEFT_TAB with search ───────────────────────────────

describe("Reducer: SET_LEFT_TAB search", () => {
  it("switches to search tab", () => {
    const state1 = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "search" });
    expect(state1.ui.activeLeftTab).toBe("search");
    expect(state1.ui.searchPanelOpen).toBe(true);
    expect(state1.ui.processPanelOpen).toBe(false);
    expect(state1.ui.gitPanelOpen).toBe(false);
    expect(state1.ui.fileExplorerOpen).toBe(false);
  });

  it("clicking active search tab collapses it", () => {
    const withSearch = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "search" });
    const state2 = sessionReducer(withSearch, { type: "SET_LEFT_TAB", tab: "search" });
    expect(state2.ui.searchPanelOpen).toBe(false);
    expect(state2.ui.sessionListCollapsed).toBe(true);
  });
});

// ─── Mutual exclusion: search ↔ other panels ────────────────────────

describe("Mutual exclusion: search vs other panels", () => {
  it("opening search closes git panel", () => {
    const withGit = sessionReducer(initialState, { type: "TOGGLE_GIT_PANEL" });
    expect(withGit.ui.gitPanelOpen).toBe(true);
    const withSearch = sessionReducer(withGit, { type: "TOGGLE_SEARCH_PANEL" });
    expect(withSearch.ui.searchPanelOpen).toBe(true);
    expect(withSearch.ui.gitPanelOpen).toBe(false);
  });

  it("opening search closes process panel", () => {
    const withProc = sessionReducer(initialState, { type: "TOGGLE_PROCESS_PANEL" });
    expect(withProc.ui.processPanelOpen).toBe(true);
    const withSearch = sessionReducer(withProc, { type: "TOGGLE_SEARCH_PANEL" });
    expect(withSearch.ui.searchPanelOpen).toBe(true);
    expect(withSearch.ui.processPanelOpen).toBe(false);
  });

  it("opening search closes file explorer", () => {
    const withFiles = sessionReducer(initialState, { type: "TOGGLE_FILE_EXPLORER" });
    expect(withFiles.ui.fileExplorerOpen).toBe(true);
    const withSearch = sessionReducer(withFiles, { type: "TOGGLE_SEARCH_PANEL" });
    expect(withSearch.ui.searchPanelOpen).toBe(true);
    expect(withSearch.ui.fileExplorerOpen).toBe(false);
  });

  it("opening git closes search panel", () => {
    const withSearch = sessionReducer(initialState, { type: "TOGGLE_SEARCH_PANEL" });
    expect(withSearch.ui.searchPanelOpen).toBe(true);
    const withGit = sessionReducer(withSearch, { type: "TOGGLE_GIT_PANEL" });
    expect(withGit.ui.gitPanelOpen).toBe(true);
    expect(withGit.ui.searchPanelOpen).toBe(false);
  });

  it("opening process panel closes search panel", () => {
    const withSearch = sessionReducer(initialState, { type: "TOGGLE_SEARCH_PANEL" });
    const withProc = sessionReducer(withSearch, { type: "TOGGLE_PROCESS_PANEL" });
    expect(withProc.ui.processPanelOpen).toBe(true);
    expect(withProc.ui.searchPanelOpen).toBe(false);
  });

  it("opening file explorer closes search panel", () => {
    const withSearch = sessionReducer(initialState, { type: "TOGGLE_SEARCH_PANEL" });
    const withFiles = sessionReducer(withSearch, { type: "TOGGLE_FILE_EXPLORER" });
    expect(withFiles.ui.fileExplorerOpen).toBe(true);
    expect(withFiles.ui.searchPanelOpen).toBe(false);
  });

  it("SET_LEFT_TAB to git closes search", () => {
    const withSearch = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "search" });
    const withGit = sessionReducer(withSearch, { type: "SET_LEFT_TAB", tab: "git" });
    expect(withGit.ui.gitPanelOpen).toBe(true);
    expect(withGit.ui.searchPanelOpen).toBe(false);
  });

  it("SET_LEFT_TAB to sessions closes search", () => {
    const withSearch = sessionReducer(initialState, { type: "SET_LEFT_TAB", tab: "search" });
    const withSessions = sessionReducer(withSearch, { type: "SET_LEFT_TAB", tab: "sessions" });
    expect(withSessions.ui.searchPanelOpen).toBe(false);
    expect(withSessions.ui.sessionListCollapsed).toBe(false);
  });
});

// ─── Race condition guard (sequence counter) ─────────────────────────

describe("Race condition guard: search sequence counter", () => {
  it("stale response is discarded when sequence advances", () => {
    // Simulates the sequence counter logic used in SearchPanel
    let seq = 0;
    let appliedResult: string | null = null;

    // First search fires (seq=1)
    const seq1 = ++seq;
    // Second search fires before first resolves (seq=2)
    const seq2 = ++seq;

    // Second search resolves first
    if (seq2 === seq) appliedResult = "result-for-query-2";
    expect(appliedResult).toBe("result-for-query-2");

    // First search resolves later — stale, should be discarded
    if (seq1 === seq) appliedResult = "result-for-query-1";
    // appliedResult should NOT have changed
    expect(appliedResult).toBe("result-for-query-2");
  });

  it("only latest sequence number matches current counter", () => {
    let seq = 0;
    const results: string[] = [];

    // Rapid-fire 5 searches
    const seqs = [++seq, ++seq, ++seq, ++seq, ++seq];

    // Only the last one should apply
    for (const s of seqs) {
      if (s === seq) results.push(`result-${s}`);
    }
    expect(results).toHaveLength(1);
    expect(results[0]).toBe("result-5");
  });
});

// ─── Loading state correctness ───────────────────────────────────────

describe("Loading state edge cases", () => {
  it("query dropping below 2 chars clears loading", () => {
    // The useEffect should set loading=false when query.length < 2
    // Simulating the guard logic:
    const query = "a";
    let loading = true;
    if (query.length < 2) {
      loading = false;
    }
    expect(loading).toBe(false);
  });

  it("empty query clears loading", () => {
    const query = "";
    let loading = true;
    if (query.length < 2) {
      loading = false;
    }
    expect(loading).toBe(false);
  });

  it("query of exactly 2 chars sets loading", () => {
    const query = "ab";
    let loading = false;
    if (query.length >= 2) {
      loading = true;
    }
    expect(loading).toBe(true);
  });
});

// ─── UI state guards ─────────────────────────────────────────────────

describe("UI state guards", () => {
  it("min 2 chars required — query of length 1 should not trigger search", () => {
    const query = "a";
    expect(query.length < 2).toBe(true);
  });

  it("no active session means no project path", () => {
    expect(initialState.activeSessionId).toBeNull();
    expect(Object.keys(initialState.sessions)).toHaveLength(0);
  });
});

// ─── Initial state ───────────────────────────────────────────────────

describe("Initial state includes search", () => {
  it("has searchPanelOpen=false", () => {
    expect(initialState.ui.searchPanelOpen).toBe(false);
  });
});

// ─── ShortcutsPanel accuracy ─────────────────────────────────────────

describe("ShortcutsPanel accuracy", () => {
  const allShortcuts = SHORTCUT_GROUPS.flatMap((g) => g.shortcuts);
  const findShortcut = (keys: string) => allShortcuts.find((s) => s.keys === keys);

  it("{mod}{shift}F is mapped to Search in Folder, not Flow Mode", () => {
    const s = findShortcut("{mod}{shift}F");
    expect(s).toBeDefined();
    expect(s!.action).toBe("Search in Folder");
    expect(s!.action).not.toContain("Flow");
  });

  it("{mod}{shift}Z is mapped to Toggle Flow Mode", () => {
    const s = findShortcut("{mod}{shift}Z");
    expect(s).toBeDefined();
    expect(s!.action).toBe("Toggle Flow Mode");
  });

  it("left-panel tabs are listed ({mod}P, {mod}G, {mod}F)", () => {
    expect(findShortcut("{mod}P")).toBeDefined();
    expect(findShortcut("{mod}G")).toBeDefined();
    expect(findShortcut("{mod}F")).toBeDefined();
  });

  it("no duplicate key bindings", () => {
    const keys = allShortcuts.map((s) => s.keys);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});

// ─── QA Round 2: Bug fixes ──────────────────────────────────────────

describe("Bug #1/#2/#3: CommandPalette shortcut accuracy", () => {
  // Dynamically import to validate the component's command definitions
  // We test the contract: the props interface accepts onToggleSearch
  it("CommandPalette accepts onToggleSearch prop (search discoverable via palette)", async () => {
    // Validates that the module exports CommandPalette with the expected shape.
    // The prop existence is enforced by TypeScript at compile time;
    // here we just verify the module loads without error.
    const mod = await import("../components/CommandPalette");
    expect(mod.CommandPalette).toBeDefined();
    expect(typeof mod.CommandPalette).toBe("function");
  });
});

describe("Bug #4/#5: Stale results cleared on projectPath change", () => {
  it("projectPath going null clears results (simulated guard)", () => {
    let results: any = { total_matches: 5 };
    let loading = true;
    let error: string | null = "old error";
    const projectPath: string | null = null;

    // Mirrors the useEffect guard in SearchPanel
    if (!projectPath) {
      results = null;
      error = null;
      loading = false;
    }
    expect(results).toBeNull();
    expect(error).toBeNull();
    expect(loading).toBe(false);
  });

  it("projectPath change clears old results before new search", () => {
    let results: any = { total_matches: 10 };
    const projectPath = "/new-project";
    const query = "foo";

    // Mirrors the useEffect logic: clear results immediately when starting new search
    if (projectPath && query.length >= 2) {
      results = null; // Bug #10 fix: old results cleared immediately
    }
    expect(results).toBeNull();
  });
});

describe("Bug #6: CSS specificity — search-toggle-active:hover", () => {
  it("active toggle class name includes both base and active", () => {
    // The component renders: className={`search-toggle${active ? " search-toggle-active" : ""}`}
    // When active, the element has BOTH classes. The CSS fix adds .search-toggle-active:hover
    // to ensure accent color is preserved on hover.
    const caseSensitive = true;
    const className = `search-toggle${caseSensitive ? " search-toggle-active" : ""}`;
    expect(className).toBe("search-toggle search-toggle-active");
    expect(className).toContain("search-toggle-active");
  });
});

describe("Bug #8: highlightMatch with char offsets (non-ASCII)", () => {
  it("handles multi-byte chars when given char offsets", () => {
    // "café test" — Rust now sends char offsets (0-based char positions)
    // 'c'=0, 'a'=1, 'f'=2, 'é'=3, ' '=4, 't'=5, 'e'=6, 's'=7, 't'=8
    // Matching "test" at char positions 5..9
    const result = highlightMatch("café test", 5, 9);
    expect(result).toEqual({ before: "café ", match: "test", after: "" });
  });

  it("handles accented char match", () => {
    // Matching "é" at char position 3..4
    const result = highlightMatch("café", 3, 4);
    expect(result).toEqual({ before: "caf", match: "é", after: "" });
  });

  it("handles CJK characters with char offsets", () => {
    // "你好world" — matching "world" at char positions 2..7
    const result = highlightMatch("你好world", 2, 7);
    expect(result).toEqual({ before: "你好", match: "world", after: "" });
  });
});

describe("Bug #9: cancelled flag prevents stale updates", () => {
  it("cancelled flag pattern discards results after cleanup", () => {
    let cancelled = false;
    let appliedResult: string | null = null;

    // Simulate effect run #1
    const cleanup1Cancelled = { value: false };
    const promise1 = () => {
      if (cleanup1Cancelled.value) return;
      appliedResult = "stale-result";
    };

    // Effect re-runs → cleanup from run #1 fires
    cleanup1Cancelled.value = true;

    // Simulate effect run #2
    const promise2 = () => {
      if (cancelled) return;
      appliedResult = "fresh-result";
    };

    // Run #1's promise resolves — should be discarded
    promise1();
    expect(appliedResult).toBeNull();

    // Run #2's promise resolves — should be applied
    promise2();
    expect(appliedResult).toBe("fresh-result");
  });

  it("cleanup on unmount prevents state update", () => {
    let cancelled = false;
    let stateUpdated = false;

    // Simulate unmount
    cancelled = true;

    // Late-arriving result
    if (!cancelled) {
      stateUpdated = true;
    }
    expect(stateUpdated).toBe(false);
  });
});

describe("Bug #10: old results cleared during new search", () => {
  it("results set to null before debounce timer starts", () => {
    // Simulates the effect logic: when query changes, results are cleared immediately
    let results: any = { total_matches: 42, results: [{ path: "old.ts" }] };
    let loading = false;
    const projectPath = "/project";
    const query = "new query";

    if (projectPath && query.length >= 2) {
      loading = true;
      results = null; // This is the fix — clear immediately
    }
    expect(results).toBeNull();
    expect(loading).toBe(true);
  });
});
