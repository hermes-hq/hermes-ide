/**
 * Tests for Git Log / Commit History feature.
 *
 * - Pure helper functions: formatCommitAge, truncateSummary, isMergeCommit, authorColor, commitStatsSummary
 * - GitLogEntry type shape tests
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
  formatCommitAge,
  truncateSummary,
  isMergeCommit,
  authorColor,
  commitStatsSummary,
} from "../components/GitLogView";
import type { GitLogEntry } from "../types/git";

// ─── Helpers ─────────────────────────────────────────────────────────

function _makeLogEntry(overrides?: Partial<GitLogEntry>): GitLogEntry {
  return {
    hash: "abc12345def67890abc12345def67890abc12345",
    short_hash: "abc12345",
    author_name: "John Doe",
    author_email: "john@example.com",
    timestamp: 1700000000,
    message: "Fix login redirect bug\n\nDetailed description here.",
    summary: "Fix login redirect bug",
    parent_count: 1,
    ...overrides,
  };
}
void _makeLogEntry; // suppress unused warning

// ─── formatCommitAge ─────────────────────────────────────────────────

describe("formatCommitAge", () => {
  const BASE = 1700000000;

  it("returns 'just now' for timestamps within 60 seconds", () => {
    expect(formatCommitAge(BASE, BASE)).toBe("just now");
    expect(formatCommitAge(BASE, BASE + 59)).toBe("just now");
  });

  it("returns minutes ago", () => {
    expect(formatCommitAge(BASE, BASE + 120)).toBe("2m ago");
    expect(formatCommitAge(BASE, BASE + 3540)).toBe("59m ago");
  });

  it("returns hours ago", () => {
    expect(formatCommitAge(BASE, BASE + 3600)).toBe("1h ago");
    expect(formatCommitAge(BASE, BASE + 7200)).toBe("2h ago");
  });

  it("returns days ago", () => {
    expect(formatCommitAge(BASE, BASE + 86400)).toBe("1d ago");
    expect(formatCommitAge(BASE, BASE + 86400 * 5)).toBe("5d ago");
  });

  it("returns weeks ago", () => {
    expect(formatCommitAge(BASE, BASE + 604800 * 2)).toBe("2w ago");
    expect(formatCommitAge(BASE, BASE + 604800 * 4)).toBe("4w ago");
  });

  it("returns months ago", () => {
    expect(formatCommitAge(BASE, BASE + 2592000 * 3)).toBe("3mo ago");
  });

  it("returns years ago", () => {
    expect(formatCommitAge(BASE, BASE + 31536000 * 2)).toBe("2y ago");
  });

  it("accepts custom now parameter", () => {
    expect(formatCommitAge(BASE, BASE + 7200)).toBe("2h ago");
  });
});

// ─── truncateSummary ─────────────────────────────────────────────────

describe("truncateSummary", () => {
  it("returns string as-is when within limit", () => {
    expect(truncateSummary("Short summary")).toBe("Short summary");
  });

  it("truncates at word boundary with ellipsis", () => {
    const long = "This is a very long commit summary message that definitely exceeds the default limit";
    const result = truncateSummary(long, 40);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(43); // 40 + "..."
  });

  it("adds ellipsis when truncated", () => {
    expect(truncateSummary("Hello world this is a test", 10)).toBe("Hello...");
  });

  it("hard truncates when no spaces", () => {
    const noSpaces = "abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789";
    const result = truncateSummary(noSpaces, 20);
    expect(result).toBe("abcdefghijklmnopqrst...");
  });

  it("returns empty string for empty input", () => {
    expect(truncateSummary("")).toBe("");
  });
});

// ─── isMergeCommit ───────────────────────────────────────────────────

describe("isMergeCommit", () => {
  it("returns false for root commit (0 parents)", () => {
    expect(isMergeCommit({ parent_count: 0 })).toBe(false);
  });

  it("returns false for normal commit (1 parent)", () => {
    expect(isMergeCommit({ parent_count: 1 })).toBe(false);
  });

  it("returns true for merge commit (2 parents)", () => {
    expect(isMergeCommit({ parent_count: 2 })).toBe(true);
  });

  it("returns true for octopus merge (3+ parents)", () => {
    expect(isMergeCommit({ parent_count: 3 })).toBe(true);
  });
});

// ─── authorColor ─────────────────────────────────────────────────────

describe("authorColor", () => {
  it("returns an hsl color string", () => {
    const color = authorColor("john@example.com");
    expect(color).toMatch(/^hsl\(\d+, 60%, 70%\)$/);
  });

  it("is deterministic (same email gives same color)", () => {
    expect(authorColor("test@example.com")).toBe(authorColor("test@example.com"));
  });

  it("returns different colors for different emails", () => {
    const c1 = authorColor("alice@example.com");
    const c2 = authorColor("bob@example.com");
    expect(c1).not.toBe(c2);
  });
});

// ─── commitStatsSummary ──────────────────────────────────────────────

describe("commitStatsSummary", () => {
  it("formats both additions and deletions", () => {
    expect(commitStatsSummary({ total_additions: 14, total_deletions: 3, files: [1, 2, 3, 4, 5] }))
      .toBe("+14 -3 (5 files)");
  });

  it("handles zero additions", () => {
    expect(commitStatsSummary({ total_additions: 0, total_deletions: 5, files: [1, 2] }))
      .toBe("+0 -5 (2 files)");
  });

  it("handles zero deletions", () => {
    expect(commitStatsSummary({ total_additions: 10, total_deletions: 0, files: [1, 2, 3] }))
      .toBe("+10 -0 (3 files)");
  });

  it("uses singular 'file' for single file", () => {
    expect(commitStatsSummary({ total_additions: 1, total_deletions: 1, files: [1] }))
      .toBe("+1 -1 (1 file)");
  });
});
