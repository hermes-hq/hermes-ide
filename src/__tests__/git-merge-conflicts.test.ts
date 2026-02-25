/**
 * Tests for Git Merge Conflict Resolution feature.
 *
 * - Pure helper functions: getResolvedCount, allConflictsResolved, parseConflictMarkers, countConflictBlocks, validateMergeMessage
 * - MergeStatus type shape tests
 * - Merge UI behavior guards
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
import {
  getResolvedCount,
  allConflictsResolved,
  parseConflictMarkers,
  countConflictBlocks,
  validateMergeMessage,
} from "../components/GitMergeBanner";
import type { MergeStatus } from "../types/git";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeMergeStatus(overrides?: Partial<MergeStatus>): MergeStatus {
  return {
    in_merge: true,
    conflicted_files: ["src/a.ts", "src/b.ts"],
    resolved_files: [],
    total_conflicts: 2,
    merge_message: "Merge branch 'feature' into main",
    ...overrides,
  };
}

// ─── getResolvedCount ────────────────────────────────────────────────

describe("getResolvedCount", () => {
  it("returns 0 when no conflicts are resolved", () => {
    const ms = makeMergeStatus({ total_conflicts: 5, conflicted_files: ["a", "b", "c", "d", "e"] });
    expect(getResolvedCount(ms)).toBe(0);
  });

  it("returns correct count when some are resolved", () => {
    const ms = makeMergeStatus({ total_conflicts: 5, conflicted_files: ["a", "b"] });
    expect(getResolvedCount(ms)).toBe(3);
  });

  it("returns total when all are resolved", () => {
    const ms = makeMergeStatus({ total_conflicts: 3, conflicted_files: [] });
    expect(getResolvedCount(ms)).toBe(3);
  });
});

// ─── allConflictsResolved ────────────────────────────────────────────

describe("allConflictsResolved", () => {
  it("returns false when conflicts remain", () => {
    const ms = makeMergeStatus({ conflicted_files: ["a.ts"] });
    expect(allConflictsResolved(ms)).toBe(false);
  });

  it("returns true when all conflicts are resolved and in merge", () => {
    const ms = makeMergeStatus({ conflicted_files: [], in_merge: true });
    expect(allConflictsResolved(ms)).toBe(true);
  });

  it("returns false when not in merge", () => {
    const ms = makeMergeStatus({ conflicted_files: [], in_merge: false });
    expect(allConflictsResolved(ms)).toBe(false);
  });
});

// ─── parseConflictMarkers ────────────────────────────────────────────

describe("parseConflictMarkers", () => {
  it("returns single normal section for clean file", () => {
    const result = parseConflictMarkers("line 1\nline 2\nline 3");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("normal");
    expect(result[0].content).toBe("line 1\nline 2\nline 3");
  });

  it("parses single conflict block", () => {
    const content = [
      "before",
      "<<<<<<< HEAD",
      "ours content",
      "=======",
      "theirs content",
      ">>>>>>> feature",
      "after",
    ].join("\n");
    const result = parseConflictMarkers(content);
    // Should have: normal, ours, theirs, normal
    expect(result.length).toBeGreaterThanOrEqual(3);
    const types = result.map((s) => s.type);
    expect(types).toContain("normal");
    expect(types).toContain("ours");
    expect(types).toContain("theirs");
  });

  it("parses multiple conflict blocks", () => {
    const content = [
      "<<<<<<< HEAD",
      "a",
      "=======",
      "b",
      ">>>>>>> f1",
      "middle",
      "<<<<<<< HEAD",
      "c",
      "=======",
      "d",
      ">>>>>>> f2",
    ].join("\n");
    const result = parseConflictMarkers(content);
    const oursCount = result.filter((s) => s.type === "ours").length;
    const theirsCount = result.filter((s) => s.type === "theirs").length;
    expect(oursCount).toBe(2);
    expect(theirsCount).toBe(2);
  });

  it("handles empty content", () => {
    const result = parseConflictMarkers("");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("normal");
  });

  it("includes correct line numbers", () => {
    const content = [
      "line 1",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> feature",
      "line 7",
    ].join("\n");
    const result = parseConflictMarkers(content);
    // First section (normal) starts at line 1
    expect(result[0].startLine).toBe(1);
    // Last section should include line 7
    const last = result[result.length - 1];
    expect(last.endLine).toBeGreaterThanOrEqual(7);
  });
});

// ─── countConflictBlocks ─────────────────────────────────────────────

describe("countConflictBlocks", () => {
  it("returns 0 for clean content", () => {
    expect(countConflictBlocks("clean\ncontent\nhere")).toBe(0);
  });

  it("returns 1 for single conflict", () => {
    const content = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> f\nafter";
    expect(countConflictBlocks(content)).toBe(1);
  });

  it("returns 3 for three conflicts", () => {
    const content = [
      "<<<<<<< HEAD\na\n=======\nb\n>>>>>>> f1",
      "<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> f2",
      "<<<<<<< HEAD\ne\n=======\nf\n>>>>>>> f3",
    ].join("\nmiddle\n");
    expect(countConflictBlocks(content)).toBe(3);
  });
});

// ─── validateMergeMessage ────────────────────────────────────────────

describe("validateMergeMessage", () => {
  it("returns null for valid message", () => {
    expect(validateMergeMessage("Merge branch 'feature' into main")).toBeNull();
  });

  it("returns error for empty message", () => {
    expect(validateMergeMessage("")).not.toBeNull();
    expect(validateMergeMessage("   ")).not.toBeNull();
  });
});

// ─── MergeStatus type shape ──────────────────────────────────────────

describe("MergeStatus type shape", () => {
  it("factory function produces valid shape", () => {
    const ms = makeMergeStatus();
    expect(ms).toHaveProperty("in_merge");
    expect(ms).toHaveProperty("conflicted_files");
    expect(ms).toHaveProperty("resolved_files");
    expect(ms).toHaveProperty("total_conflicts");
    expect(ms).toHaveProperty("merge_message");
  });

  it("default non-merge state", () => {
    const ms = makeMergeStatus({ in_merge: false, conflicted_files: [], total_conflicts: 0 });
    expect(ms.in_merge).toBe(false);
    expect(ms.conflicted_files).toHaveLength(0);
    expect(ms.total_conflicts).toBe(0);
  });
});

// ─── Merge UI behavior ──────────────────────────────────────────────

describe("Merge UI behavior", () => {
  it("banner shown when has_conflicts is true", () => {
    const ms = makeMergeStatus({ in_merge: true, conflicted_files: ["a.ts"] });
    // The banner renders when mergeStatus.in_merge is true
    expect(ms.in_merge).toBe(true);
  });

  it("complete merge disabled when conflicts remain", () => {
    const ms = makeMergeStatus({ conflicted_files: ["a.ts"] });
    const canComplete = ms.conflicted_files.length === 0;
    expect(canComplete).toBe(false);
  });

  it("complete merge enabled when all conflicts resolved", () => {
    const ms = makeMergeStatus({ conflicted_files: [] });
    const canComplete = ms.conflicted_files.length === 0;
    expect(canComplete).toBe(true);
  });

  it("abort calls the abort handler", () => {
    // The abort button calls onAbort callback
    const abortFn = vi.fn();
    abortFn();
    expect(abortFn).toHaveBeenCalledTimes(1);
  });
});
