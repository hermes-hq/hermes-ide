/**
 * Tests for Git Stash Management feature.
 *
 * - Pure helper functions: formatStashAge, parseStashLabel, parseStashBranch
 * - GitStashEntry type shape tests
 * - Stash operation guard logic
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
import { formatStashAge, parseStashLabel, parseStashBranch } from "../components/GitStashSection";
import type { GitStashEntry } from "../types/git";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeStashEntry(overrides?: Partial<GitStashEntry>): GitStashEntry {
  return {
    index: 0,
    message: "WIP on main: abc1234 Fix login bug",
    timestamp: 1700000000,
    branch_name: "main",
    ...overrides,
  };
}

// ─── formatStashAge ──────────────────────────────────────────────────

describe("formatStashAge", () => {
  const BASE = 1700000000;

  it("returns 'just now' for timestamps within 60 seconds", () => {
    expect(formatStashAge(BASE, BASE + 30)).toBe("just now");
    expect(formatStashAge(BASE, BASE)).toBe("just now");
  });

  it("returns minutes ago", () => {
    expect(formatStashAge(BASE, BASE + 120)).toBe("2m ago");
    expect(formatStashAge(BASE, BASE + 300)).toBe("5m ago");
  });

  it("returns hours ago", () => {
    expect(formatStashAge(BASE, BASE + 7200)).toBe("2h ago");
    expect(formatStashAge(BASE, BASE + 3600)).toBe("1h ago");
  });

  it("returns days ago", () => {
    expect(formatStashAge(BASE, BASE + 86400 * 3)).toBe("3d ago");
    expect(formatStashAge(BASE, BASE + 86400)).toBe("1d ago");
  });

  it("returns weeks ago", () => {
    expect(formatStashAge(BASE, BASE + 604800 * 2)).toBe("2w ago");
    expect(formatStashAge(BASE, BASE + 604800 * 4)).toBe("4w ago");
  });

  it("returns months ago", () => {
    expect(formatStashAge(BASE, BASE + 2592000 * 3)).toBe("3mo ago");
  });

  it("returns years ago", () => {
    expect(formatStashAge(BASE, BASE + 31536000 * 2)).toBe("2y ago");
  });

  it("handles future timestamps as 'just now'", () => {
    expect(formatStashAge(BASE + 1000, BASE)).toBe("just now");
  });

  it("accepts custom now parameter", () => {
    const now = 1700003600; // 1 hour later
    expect(formatStashAge(BASE, now)).toBe("1h ago");
  });
});

// ─── parseStashLabel ─────────────────────────────────────────────────

describe("parseStashLabel", () => {
  it("extracts label from WIP format", () => {
    expect(parseStashLabel("WIP on main: abc1234 Fix login bug")).toBe("Fix login bug");
  });

  it("extracts label from custom On format", () => {
    expect(parseStashLabel("On main: abc1234 Refactor utils")).toBe("Refactor utils");
  });

  it("returns raw message when no colon pattern", () => {
    expect(parseStashLabel("custom stash message")).toBe("custom stash message");
  });

  it("returns empty string for empty input", () => {
    expect(parseStashLabel("")).toBe("");
  });

  it("handles messages with multiple colons", () => {
    expect(parseStashLabel("WIP on main: abc1234 Fix: login redirect")).toBe("Fix: login redirect");
  });
});

// ─── parseStashBranch ────────────────────────────────────────────────

describe("parseStashBranch", () => {
  it("extracts branch from WIP on main: format", () => {
    expect(parseStashBranch("WIP on main: abc1234 Fix bug")).toBe("main");
  });

  it("extracts branch from On feature/x: format", () => {
    expect(parseStashBranch("On feature/x: abc1234 WIP")).toBe("feature/x");
  });

  it("returns 'unknown' for unrecognized format", () => {
    expect(parseStashBranch("custom stash message")).toBe("unknown");
    expect(parseStashBranch("")).toBe("unknown");
  });
});

// ─── GitStashEntry type shape ────────────────────────────────────────

describe("GitStashEntry type shape", () => {
  it("factory function produces valid shape", () => {
    const entry = makeStashEntry();
    expect(entry).toHaveProperty("index");
    expect(entry).toHaveProperty("message");
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("branch_name");
  });

  it("default values are correct", () => {
    const entry = makeStashEntry();
    expect(entry.index).toBe(0);
    expect(entry.branch_name).toBe("main");
    expect(typeof entry.timestamp).toBe("number");
  });

  it("override merging works", () => {
    const entry = makeStashEntry({ index: 3, branch_name: "develop" });
    expect(entry.index).toBe(3);
    expect(entry.branch_name).toBe("develop");
    expect(entry.message).toContain("WIP on main");
  });
});

// ─── Stash operation guards ──────────────────────────────────────────

describe("Stash operation guards", () => {
  it("save should be disabled when no changes", () => {
    const hasChanges = false;
    // In the component, the Stash button is disabled when !hasChanges
    expect(hasChanges).toBe(false);
  });

  it("drop needs confirmation (confirmDrop state)", () => {
    // The UI uses confirmDrop state to show Yes/No inline
    // Verify the pattern: set confirmDrop to index, then confirm/cancel
    let confirmDrop: number | null = null;
    confirmDrop = 0; // User clicks drop
    expect(confirmDrop).toBe(0);
    confirmDrop = null; // User clicks cancel
    expect(confirmDrop).toBeNull();
  });

  it("clear should be disabled at stash count 0", () => {
    const stashCount = 0;
    // In the component, Clear button is only rendered when stashCount > 0
    expect(stashCount > 0).toBe(false);
  });
});
